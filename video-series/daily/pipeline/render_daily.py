#!/usr/bin/env python3
"""PiDeck AI 日更 · 成片渲染：HTML → 截图 → TTS(+SRT) → 烧字幕 → 分片 → concat。

一次 TTS 出两种画幅：旁白与字幕时间轴在两个画幅间共享，只有烧录样式不同。

用法：
  python render_daily.py --script daily/scripts/2026-10-20.json
  python render_daily.py --script daily/scripts/2026-10-20.json --formats 16x9   # 只出一个画幅
  python render_daily.py --script daily/scripts/2026-10-20.json --no-tts        # 复用已有音频
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from templates.deck_css import FORMATS  # noqa: E402
from pipeline.daily_deck import DAILY, build, load_episode  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

TTS_PROXY = "http://127.0.0.1:7890"


def find_chromium() -> str | None:
    """本机 ms-playwright 的 chromium 路径（版本目录会变，取最新的一个）。"""
    root = Path.home() / "AppData/Local/ms-playwright"
    if not root.exists():
        return None
    candidates = sorted(root.glob("chromium-*/chrome-win*/chrome.exe"), reverse=True)
    return str(candidates[0]) if candidates else None


def tts(text: str, out_mp3: Path, out_srt: Path, voice: str, rate: str, pitch: str, force: bool) -> None:
    """edge-tts 子进程调用，产出 mp3 + 短语级 SRT。已有文件且非空则复用。"""
    if not force and out_mp3.exists() and out_mp3.stat().st_size > 500 and out_srt.exists() and out_srt.stat().st_size > 50:
        return
    out_mp3.parent.mkdir(parents=True, exist_ok=True)
    txt = out_mp3.with_suffix(".in.txt")
    txt.write_text(text, encoding="utf-8")
    cmd = [
        sys.executable,
        "-m",
        "edge_tts",
        f"--voice={voice}",
        f"--rate={rate}",
        f"--pitch={pitch}",
        f"--file={txt}",
        f"--write-media={out_mp3}",
        f"--write-subtitles={out_srt}",
    ]
    attempts = [cmd + [f"--proxy={TTS_PROXY}"], cmd]
    last = ""
    for attempt in attempts:
        r = subprocess.run(attempt, capture_output=True, text=True)
        if r.returncode == 0 and out_mp3.exists() and out_mp3.stat().st_size > 500:
            return
        last = r.stderr or r.stdout
    raise SystemExit(f"TTS 失败: {last.strip()[:400]}")


def screenshot_all(html_files: list[Path], width: int, height: int, out_dir: Path) -> dict[Path, Path]:
    """同一画幅的幻灯片共用一个 Chromium 实例，截图 1:1 像素。"""
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    mapping: dict[Path, Path] = {}
    launch_kwargs: dict = {"headless": True}
    chrome_exe = find_chromium()
    if chrome_exe:
        launch_kwargs["executable_path"] = chrome_exe
    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
        for html in html_files:
            png = out_dir / f"{html.stem}.png"
            page.goto(html.resolve().as_uri(), wait_until="networkidle")
            page.screenshot(path=str(png), full_page=False)
            if not png.exists() or png.stat().st_size < 1000:
                raise SystemExit(f"截图失败: {png}")
            mapping[html] = png
        browser.close()
    return mapping


def _char_em(ch: str) -> float:
    """粗略字宽：CJK 与全角标点算 1 em，ASCII 算 0.5 em。"""
    return 1.0 if ord(ch) > 0x2E80 else 0.5


def wrap_cjk(text: str, max_em: float) -> str:
    """按宽度手工折行。

    libass 不会给无空格的中文断行（它只在空格/连字符处断），长句会直接顶出画面两侧。
    这里先自己折好，再用 ASS 的 \\N 硬换行。避头尾：行首不落标点，行尾不挂开引号。
    """
    lines: list[str] = []
    cur = ""
    cur_w = 0.0
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur, cur_w = "", 0.0
            continue
        w = _char_em(ch)
        if cur_w + w > max_em and cur:
            # 尽量在标点后断行：向前找最近的标点/空格
            cut = len(cur)
            for i in range(len(cur) - 1, max(-1, len(cur) - 12), -1):
                if cur[i] in "，。！？；：、,.!?;: ":
                    cut = i + 1
                    break
            # 避头尾：行首不能是收尾标点
            while cut < len(cur) and cur[cut] in "，。！？；：、,.!?;:":
                cut += 1
            lines.append(cur[:cut])
            cur = cur[cut:]
            cur_w = sum(_char_em(c) for c in cur)
        cur += ch
        cur_w += w
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def srt_to_ass(srt_path: Path, out_ass: Path, width: int, height: int, style: dict) -> Path:
    """把 edge-tts 的 SRT 转成 ASS，并显式写死 PlayResX/PlayResY。

    为什么不用 `subtitles=xxx.srt:force_style=...`：SRT 没有分辨率信息，ffmpeg 内部转 ASS 时
    固定用 384x288 作脚本分辨率，libass 再按画面尺寸缩放——26 号字在 1080p 下会被放大到
    近 100px，字幕直接盖住画面。写成同尺寸的 ASS 后，样式里的数字就是真实像素。
    """
    out_ass.parent.mkdir(parents=True, exist_ok=True)
    raw = srt_path.read_text(encoding="utf-8-sig")
    blocks = [b for b in re.split(r"\r?\n\r?\n", raw.strip()) if b.strip()]
    max_em = style.get("max_em", 0)

    def to_ass_time(ts: str) -> str:
        # SRT "00:00:01,250" → ASS "0:00:01.25"
        h, m, rest = ts.split(":")
        s, _, ms = rest.replace(",", ".").partition(".")
        total = int(s) + int(ms.ljust(3, "0") or 0) / 1000
        return f"{int(h)}:{int(m):02d}:{total:05.2f}"

    events: list[str] = []
    for block in blocks:
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2 or "-->" not in lines[1]:
            continue
        start, end = [part.strip() for part in lines[1].split("-->")]
        text = "\n".join(lines[2:])
        if max_em:
            text = wrap_cjk(text, max_em)
        text = text.replace("\n", "\\N")
        events.append(
            f"Dialogue: 0,{to_ass_time(start)},{to_ass_time(end)},{style['style']},,,0,0,0,,{text}"
        )

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: {style['style']},{style['font']},{style['size']},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,1,0,2,{style['margin_h']},{style['margin_h']},{style['margin_v']},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    out_ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_ass


def burn_clip(png: Path, mp3: Path, ass: Path, out_mp4: Path) -> None:
    """静帧 + 旁白 → 烧字幕 → 单页 MP4。

    输入用绝对路径：ffmpeg 的 cwd 切到资产目录只是为了让 ass 滤镜能拿到裸文件名
    （Windows 下带盘符的路径在滤镜里转义麻烦），输入文件不在这层。
    """
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    vf = f"ass={ass.name}"
    cmd = [
        "ffmpeg",
        "-y",
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        str(png.resolve()),
        "-i",
        str(mp3.resolve()),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-tune",
        "stillimage",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        out_mp4.resolve().as_posix(),
    ]
    r = subprocess.run(cmd, cwd=str(ass.parent), capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg 失败: {(r.stderr or r.stdout)[-1200:]}")


def concat(clips: list[Path], out_mp4: Path) -> None:
    list_file = out_mp4.parent / "concat_list.txt"
    lines = [f"file '{c.resolve().as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for c in clips]
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out_mp4)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"concat 失败: {(r.stderr or r.stdout)[-800:]}")


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def render(episode: dict, script_path: Path, formats: list[str], force_tts: bool, skip_tts: bool) -> list[Path]:
    out_dir = DAILY / "out" / episode["date"]
    build(episode, out_dir)  # 先出 HTML，保证画幅与脚本同步

    voice = episode.get("voice", {})
    voice_name = voice.get("name", "zh-CN-YunxiNeural")
    rate = voice.get("rate", "-10%")
    pitch = voice.get("pitch", "-2Hz")

    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = out_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    # 1) 旁白：每个 slide 一次 TTS，字幕 SRT 跟着一起产出
    audio: dict[str, tuple[Path, Path]] = {}
    for i, slide in enumerate(episode["slides"], 1):
        mp3 = audio_dir / f"{slide['id']}.mp3"
        srt = audio_dir / f"{slide['id']}.srt"
        if skip_tts:
            if not mp3.exists() or not srt.exists():
                raise SystemExit(f"--no-tts 但缺少音频: {mp3.name}")
        else:
            tts(slide["narration"], mp3, srt, voice_name, rate, pitch, force_tts)
        audio[slide["id"]] = (mp3, srt)
        print(f"  [{i}/{len(episode['slides'])}] 旁白 {slide['id']} ({len(slide['narration'])} 字)")

    finals: list[Path] = []
    for fmt in formats:
        spec = FORMATS[fmt]
        html_dir = out_dir / "html" / fmt
        html_files = [html_dir / f"{s['id']}.html" for s in episode["slides"]]
        missing = [h for h in html_files if not h.exists()]
        if missing:
            raise SystemExit(f"缺少幻灯片: {missing[0]}")

        print(f"▶ 画幅 {fmt}：截图 {len(html_files)} 张…")
        shots = screenshot_all(html_files, spec["width"], spec["height"], out_dir / "shots" / fmt)

        clips: list[Path] = []
        for slide in episode["slides"]:
            png = shots[html_dir / f"{slide['id']}.html"]
            mp3, srt = audio[slide["id"]]
            # 字幕按画幅转 ASS：PlayRes 跟画幅走，字号才是真实像素
            ass = srt_to_ass(
                srt,
                out_dir / "subtitles" / fmt / f"{slide['id']}.ass",
                spec["width"],
                spec["height"],
                spec["subtitle"],
            )
            clip = clips_dir / fmt / f"{slide['id']}.mp4"
            burn_clip(png, mp3, ass, clip)
            clips.append(clip)
            print(f"  ✓ {fmt}/{clip.name}")

        final = out_dir / f"{episode['date']}-{fmt}.mp4"
        concat(clips, final)
        dur = probe_duration(final)
        size_mb = final.stat().st_size // 1024 // 1024
        print(f"✅ {final.name}  {dur:.1f}s  {size_mb}MB")
        finals.append(final)

    return finals


def main() -> None:
    parser = argparse.ArgumentParser(description="每日脚本 → 成片")
    parser.add_argument("--script", required=True, help="scripts/YYYY-MM-DD.json")
    parser.add_argument("--formats", default="", help="逗号分隔的画幅，默认用脚本里的 formats")
    parser.add_argument("--force-tts", action="store_true", help="忽略缓存重新配音")
    parser.add_argument("--no-tts", action="store_true", help="跳过 TTS，复用已有音频（调样式用）")
    args = parser.parse_args()

    script = Path(args.script)
    if not script.is_absolute():
        script = (Path.cwd() / script).resolve()
    if not script.exists():
        raise SystemExit(f"找不到脚本: {script}")

    episode = load_episode(script)
    formats = [f.strip() for f in args.formats.split(",") if f.strip()] or episode.get("formats", ["16x9", "3x4"])
    for f in formats:
        if f not in FORMATS:
            raise SystemExit(f"未知画幅: {f}")

    print(f"▶ {episode['date']} · {episode.get('title', '')}")
    finals = render(episode, script, formats, args.force_tts, args.no_tts)

    manifest = {
        "date": episode["date"],
        "title": episode.get("title", ""),
        "episode": episode.get("episode"),
        "kind": episode.get("kind"),
        "videos": [{"file": f.name, "durationSec": round(probe_duration(f), 1)} for f in finals],
    }
    (DAILY / "out" / episode["date"] / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("📋 manifest.json 已写出")


if __name__ == "__main__":
    main()
