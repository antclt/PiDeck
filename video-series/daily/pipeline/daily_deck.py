#!/usr/bin/env python3
"""PiDeck AI 日更 · 每日脚本 JSON → HTML 幻灯片（16:9 + 3:4 双画幅）。

输入：`daily/scripts/YYYY-MM-DD.json`（写稿 prompt 产出的定稿）
输出：`daily/out/<date>/html/<format>/<slide-id>.html`

脚本结构见 `video-series/WORKFLOW.md` 第 11 节。每个 slide 必须有 `narration`（口播词），
渲染时按 slide 逐段 TTS，字幕由 edge-tts 产出的 SRT 烧进画面。
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from templates.deck_css import FORMATS  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

DAILY = Path(__file__).resolve().parent.parent
REPO_ROOT = DAILY.parent.parent


def esc(text: str) -> str:
    return html.escape(str(text), quote=True)


def img_uri(raw: str) -> str:
    """把仓库内相对路径转成 file:// 绝对 URI，Playwright 截图时能正常加载。"""
    p = Path(raw)
    if not p.is_absolute():
        p = REPO_ROOT / p
    return p.resolve().as_uri()


def crop_box(crop: dict, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """把比例裁剪框换算成像素框。x/y/w/h 都是 0..1 的比例。"""
    w, h = size
    x = max(0, min(1.0, float(crop.get("x", 0))))
    y = max(0, min(1.0, float(crop.get("y", 0))))
    cw = max(0.01, min(1.0 - x, float(crop.get("w", 1))))
    ch = max(0.01, min(1.0 - y, float(crop.get("h", 1))))
    return (int(x * w), int(y * h), int((x + cw) * w), int((y + ch) * h))


def prepare_image(src: str, crop: dict | None, out_path: Path) -> str:
    """按比例裁剪产品截图并缓存，返回可直接引用的绝对路径。

    16:9 产品截图原样用在横版；竖版（3:4）要裁到「弹窗/面板」那块，
    否则整屏缩到窄画幅里只剩一条，看不清在演示什么。
    Pillow 缺失时退化为不裁剪（fail-safe：出片优先于构图）。
    """
    source = Path(src)
    if not source.is_absolute():
        source = REPO_ROOT / source
    if not crop:
        return str(source.resolve())
    try:
        from PIL import Image
    except ImportError:
        print(f"⚠️ 未安装 Pillow，跳过裁剪: {src}")
        return str(source.resolve())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as im:
        im.convert("RGB").crop(crop_box(crop, im.size)).save(out_path)
    return str(out_path.resolve())


def slide_body(slide: dict, fmt: str = "16x9", image: str | None = None) -> str:
    """按 slide.type 渲染正文 HTML。

    竖版（3:4）和横版（16:9）的 shot 排版不同：横版文字在上、图在下；竖版图在上、文字在下，
    否则 16:9 截图在窄画幅里只剩一条，中间大片空白。
    """
    kind = slide.get("type", "bullets")
    title = slide.get("title")
    lead = slide.get("lead")

    if kind == "cover":
        parts = [f'<h1>{esc(slide.get("main", title or ""))}</h1>']
        if slide.get("sub"):
            parts.append(f'<p class="lead" style="margin-top:28px">{esc(slide["sub"])}</p>')
        return "".join(parts)

    if kind == "hook":
        parts = []
        if slide.get("kicker"):
            parts.append(f'<div class="kicker">{esc(slide["kicker"])}</div>')
        if title:
            parts.append(f"<h1>{esc(title)}</h1>")
        if lead:
            parts.append(f'<p class="lead" style="margin-top:30px">{esc(lead)}</p>')
        return "".join(parts)

    if kind == "steps":
        items = "".join(
            f'<li><span class="n">{i + 1}</span><span>{esc(s)}</span></li>' for i, s in enumerate(slide.get("bullets", []))
        )
        head = f'<h2 style="margin-bottom:32px">{esc(title)}</h2>' if title else ""
        return head + f'<ol class="steps">{items}</ol>'

    if kind == "bullets":
        items = "".join(
            f'<li><span class="n">{i + 1}</span><span>{esc(s)}</span></li>' for i, s in enumerate(slide.get("bullets", []))
        )
        head = f'<h2 style="margin-bottom:32px">{esc(title)}</h2>' if title else ""
        sub = f'<p class="lead" style="margin-top:24px">{esc(lead)}</p>' if lead else ""
        return head + f'<ul class="bullets">{items}</ul>' + sub

    if kind == "shot":
        src = image or (img_uri(slide["image"]) if slide.get("image") else "")
        img = f'<img src="{esc(src)}" alt="">' if src else ""
        cap = f'<p class="shot-cap">{esc(slide["caption"])}</p>' if slide.get("caption") else ""
        if fmt == "3x4":
            # 竖版：图在上、标题在下、说明最后，避免 16:9 截图在窄画幅里被压成一条
            img_block = f'<div class="shot shot-v"><div class="shot-img">{img}</div></div>'
            cap = f'<p class="shot-cap" style="margin-top:20px">{esc(slide["caption"])}</p>' if slide.get("caption") else ""
            return img_block + (f'<h2 style="margin-top:32px">{esc(title)}</h2>' if title else "") + cap
        # 横版：截图多是竖长条，铺满 16:9 会两侧留大片空底 → 改左右分栏
        copy = f'<h2>{esc(title)}</h2>' if title else ""
        copy += cap
        return f'<div class="shot-2col"><div class="shot-copy">{copy}</div><div class="shot-img">{img}</div></div>'

    if kind == "quote":
        return f'<div class="quote">{esc(slide.get("text") or title or "")}</div>'

    if kind == "cta":
        chips = "".join(f'<span class="chip">{esc(c)}</span>' for c in slide.get("bullets", []))
        head = f'<h1 style="font-size:var(--fs-h2)">{esc(title)}</h1>' if title else ""
        sub = f'<p class="lead" style="margin-top:24px">{esc(lead)}</p>' if lead else ""
        return head + sub + (f'<div class="cta-row" style="margin-top:36px">{chips}</div>' if chips else "")

    raise ValueError(f"未知 slide.type: {kind}")


def render_slide(slide: dict, episode: dict, fmt: str, image: str | None = None) -> str:
    spec = FORMATS[fmt]
    brand = episode.get("brand", "PiDeck")
    slogan = episode.get("slogan", "")
    ep_tag = episode.get("epTag", "")
    foot_right = episode.get("footRight", "")

    body = slide_body(slide, fmt, image)
    # 日更短视频一屏只讲一件事，内容居中比顶对齐更有劲；
    # shot 类型由 .shot-2col / .shot-v 自行控制对齐。
    body_style = "justify-content:center;" if slide.get("type") != "shot" else ""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>{spec['css']}</style>
</head>
<body>
<div class="slide">
  <div class="mast">
    <div class="brand"><span class="brand-mark"></span><span class="brand-text">{esc(brand)}</span></div>
    <div class="ep-tag">{esc(ep_tag)}</div>
  </div>
  <div class="body" style="{body_style}">{body}</div>
  <div class="foot">
    <span>{esc(slogan)}</span>
    <span class="mono">{esc(foot_right)}</span>
  </div>
</div>
</body>
</html>
"""


def build(episode: dict, out_dir: Path) -> list[Path]:
    """生成所有画幅的 HTML，返回写出的文件列表。"""
    written: list[Path] = []
    for fmt in episode.get("formats", ["16x9", "3x4"]):
        if fmt not in FORMATS:
            raise ValueError(f"未知画幅: {fmt}")
        html_dir = out_dir / "html" / fmt
        html_dir.mkdir(parents=True, exist_ok=True)
        for slide in episode["slides"]:
            image = None
            if slide.get("image"):
                # crop：两种画幅可分别指定；crop3x4 只影响竖版，缺省回退到 crop
                crop = slide.get("crop") if fmt == "16x9" else (slide.get("crop3x4") or slide.get("crop"))
                image = prepare_image(slide["image"], crop, out_dir / "assets" / fmt / f"{slide['id']}.png")
            target = html_dir / f"{slide['id']}.html"
            target.write_text(render_slide(slide, episode, fmt, image), encoding="utf-8")
            written.append(target)
    return written


def load_episode(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    for slide in data.get("slides", []):
        if not slide.get("narration", "").strip():
            raise ValueError(f"slide {slide.get('id')} 缺少 narration（口播词）")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description="每日脚本 JSON → HTML 幻灯片")
    parser.add_argument("--script", required=True, help="scripts/YYYY-MM-DD.json")
    parser.add_argument("--out", default="", help="输出目录，默认 daily/out/<date>")
    args = parser.parse_args()

    script = Path(args.script)
    if not script.is_absolute():
        script = (Path.cwd() / script).resolve()
    episode = load_episode(script)
    out_dir = Path(args.out) if args.out else DAILY / "out" / episode["date"]
    out_dir.mkdir(parents=True, exist_ok=True)

    written = build(episode, out_dir)
    print(f"✅ 生成 {len(written)} 个 HTML → {out_dir}")


if __name__ == "__main__":
    main()
