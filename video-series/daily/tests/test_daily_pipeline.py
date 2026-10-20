#!/usr/bin/env python3
"""PiDeck AI 日更管线的纯逻辑单测。

只测不碰 IO 的函数：字幕折行、SRT→ASS 转换、裁剪框换算、发布文案裁剪。
这些是踩过坑的地方（libass 会把 SRT 的 384×288 脚本分辨率放大、也不会给中文断行），
必须有回归守住。

跑法：
  python video-series/daily/tests/test_daily_pipeline.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.daily_deck import crop_box  # noqa: E402
from pipeline.publish_copy import clip  # noqa: E402
from pipeline.render_daily import srt_to_ass, wrap_cjk  # noqa: E402
from templates.deck_css import FORMATS  # noqa: E402


class WrapCjkTest(unittest.TestCase):
    """中文没有空格，libass 不会自己断行——必须预折。"""

    def test_short_text_keeps_single_line(self):
        self.assertEqual(wrap_cjk("还在手打文件路径？", 20), "还在手打文件路径？")

    def test_long_text_wraps_within_budget(self):
        text = "在输入框敲一个 @，PiDeck 立刻弹出你项目里的文件列表，上下键一选，回车确认，文件就插进消息了。"
        lines = wrap_cjk(text, 20).split("\n")
        self.assertGreater(len(lines), 1)
        for line in lines:
            # 一行 = 一个 CJK 字符或半个 ASCII 字符
            width = sum(1.0 if ord(c) > 0x2E80 else 0.5 for c in line)
            self.assertLessEqual(width, 20 + 0.5)

    def test_breaks_only_at_punctuation_or_space(self):
        # 中文没空格，必须落在标点/空格这类自然边界上，不能把一个词从中间劈开
        text = "选中之后，路径会原样写进消息里，Agent 拿着这个路径就能自己去看源码。"
        lines = wrap_cjk(text, 20).split("\n")
        for line in lines[:-1]:
            self.assertTrue(
                line.endswith(("，", "。", "、", " ", ",", ".")),
                f"断行位置不是自然边界: {line!r}",
            )

    def test_never_starts_line_with_closing_punctuation(self):
        lines = wrap_cjk("一二三四五六七八九十，甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。", 8).split("\n")
        for line in lines:
            self.assertNotIn(line[0], "，。！？；：、,.!?;:")

    def test_keeps_explicit_newline(self):
        self.assertEqual(wrap_cjk("上\n下", 20), "上\n下")


class SrtToAssTest(unittest.TestCase):
    def _write_srt(self, tmp: Path, body: str) -> Path:
        p = tmp / "x.srt"
        p.write_text(body, encoding="utf-8")
        return p

    def test_playres_matches_frame_size(self, ):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            srt = self._write_srt(tmp, "1\n00:00:01,250 --> 00:00:03,500\n你好\n")
            out = srt_to_ass(srt, tmp / "x.ass", 1920, 1080, FORMATS["16x9"]["subtitle"])
            text = out.read_text(encoding="utf-8")
        self.assertIn("PlayResX: 1920", text)
        self.assertIn("PlayResY: 1080", text)
        # 字号是真实像素，不是 SRT 隐含的 384×288 脚本分辨率
        style_line = next(ln for ln in text.splitlines() if ln.startswith("Style:"))
        self.assertIn(f",{FORMATS['16x9']['subtitle']['size']},", style_line)

    def test_event_times_are_converted(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            srt = self._write_srt(tmp, "1\n00:00:01,250 --> 00:00:03,500\n你好\n")
            out = srt_to_ass(srt, tmp / "x.ass", 1920, 1080, FORMATS["16x9"]["subtitle"])
            text = out.read_text(encoding="utf-8")
        self.assertIn("Dialogue: 0,0:00:01.25,0:00:03.50,", text)
        self.assertTrue(text.rstrip().endswith("你好"))

    def test_long_cue_is_prewrapped(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            srt = self._write_srt(
                tmp,
                "1\n00:00:01,000 --> 00:00:05,000\n"
                "在输入框敲一个 @，PiDeck 立刻弹出你项目里的文件列表，上下键一选，回车确认，文件就插进消息了。\n",
            )
            out = srt_to_ass(srt, tmp / "x.ass", 1080, 1440, FORMATS["3x4"]["subtitle"])
            text = out.read_text(encoding="utf-8")
        self.assertIn("\\N", text)  # 预折行写成了 ASS 硬换行


class CropBoxTest(unittest.TestCase):
    def test_ratio_to_pixels(self):
        self.assertEqual(crop_box({"x": 0.5, "y": 0.25, "w": 0.25, "h": 0.5}, (1000, 800)), (500, 200, 750, 600))

    def test_missing_keys_default_to_full_frame(self):
        self.assertEqual(crop_box({}, (1000, 800)), (0, 0, 1000, 800))

    def test_out_of_range_is_clamped(self):
        x0, y0, x1, y1 = crop_box({"x": -1, "y": 0, "w": 5, "h": 1}, (100, 100))
        self.assertEqual((x0, y0, x1, y1), (0, 0, 100, 100))


class PublishClipTest(unittest.TestCase):
    def test_short_text_untouched(self):
        self.assertEqual(clip("短标题", 30), "短标题")

    def test_long_text_truncated_with_ellipsis(self):
        out = clip("一" * 50, 30)
        self.assertEqual(len(out), 30)
        self.assertTrue(out.endswith("…"))


if __name__ == "__main__":
    unittest.main()
