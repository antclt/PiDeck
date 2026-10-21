"""PiDeck AI 日更 · 幻灯片设计语言（16:9 + 3:4 双画幅）。

视觉 token 与 `video-series/decks/generate_decks.py` 的 EP 系列保持一致：
bg #0e1116 / surface #171b22 / text #e8eaed / muted #9aa3b2 / accent #d4a574。
日更视频比系列教程更短更冲，所以标题更大、留白更狠、每屏只讲一件事。
"""

TOKENS = """
:root {
  --bg: #0e1116;
  --surface: #171b22;
  --line: rgba(255,255,255,0.08);
  --text: #e8eaed;
  --muted: #9aa3b2;
  --dim: #6b7380;
  --accent: #d4a574;
  --accent-soft: rgba(212,165,116,0.14);
  --ok: #6fbf8a;
  --bad: #e07a6a;
  --font: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: "Cascadia Code", "Consolas", "SF Mono", ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: var(--font);
  -webkit-font-smoothing: antialiased;
}
"""


def _common() -> str:
    """两种画幅共用的组件样式（差异只在尺寸变量上）。"""
    return """
.slide {
  position: relative; overflow: hidden;
  display: flex; flex-direction: column;
  background:
    radial-gradient(1200px 600px at 100% -10%, rgba(212,165,116,0.09), transparent 55%),
    radial-gradient(900px 500px at -10% 110%, rgba(90,120,160,0.09), transparent 50%),
    var(--bg);
}
.slide::before {
  content: ""; position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px);
  background-size: var(--grid) var(--grid);
  pointer-events: none;
}
.mast {
  display: flex; justify-content: space-between; align-items: center;
  position: relative; z-index: 1;
}
.brand { display: flex; align-items: center; gap: var(--gap-s); color: var(--muted); letter-spacing: 0.04em; }
.brand-mark {
  width: var(--mark); height: var(--mark); border-radius: 8px;
  background: linear-gradient(135deg, #d4a574, #8f6b45);
  box-shadow: 0 0 0 1px rgba(212,165,116,0.35);
}
.brand-text { font-size: var(--fs-mast); }
.ep-tag {
  font-family: var(--mono); font-size: var(--fs-tag); color: var(--accent);
  background: var(--accent-soft); border: 1px solid rgba(212,165,116,0.28);
  padding: var(--pad-tag) var(--pad-tag-x); border-radius: 999px; letter-spacing: 0.06em;
}
.body { flex: 1; display: flex; flex-direction: column; position: relative; z-index: 1; min-height: 0; }
.foot {
  display: flex; justify-content: space-between; align-items: center;
  color: var(--dim); font-size: var(--fs-foot); position: relative; z-index: 1;
}
.foot .mono { font-family: var(--mono); }
h1 { font-size: var(--fs-h1); line-height: 1.12; font-weight: 680; letter-spacing: -0.02em; }
h2 { font-size: var(--fs-h2); line-height: 1.2; font-weight: 660; letter-spacing: -0.015em; }
.lead { color: var(--muted); line-height: 1.5; font-size: var(--fs-lead); }
.accent { color: var(--accent); }
.dim { color: var(--dim); }
.muted { color: var(--muted); }
.kicker {
  font-family: var(--mono); font-size: var(--fs-kicker); color: var(--accent);
  letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: var(--gap-l);
}
.bullets { list-style: none; display: flex; flex-direction: column; gap: var(--gap-m); }
.bullets li {
  display: grid; grid-template-columns: var(--bullet-n) 1fr; gap: var(--gap-s);
  align-items: start; font-size: var(--fs-body); line-height: 1.45;
}
.bullets .n {
  width: var(--bullet-n); height: var(--bullet-n); border-radius: 10px;
  display: grid; place-items: center; font-family: var(--mono);
  font-size: var(--fs-num); background: var(--surface); color: var(--accent);
  border: 1px solid var(--line);
}
.shot { position: relative; display: flex; flex-direction: column; gap: var(--gap-m); min-height: 0; flex: 1; }
.shot-img {
  flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
}
/* 边框贴着图走，不贴着容器走：容器是 flex:1 会横跨整幅，宽画幅下会在图两侧留出大片空底。
   width:100% + height:auto + max-height:100% 会按比例缩放并把框收到图的真实尺寸上。 */
.shot-img img {
  width: 100%; height: auto; max-height: 100%; display: block;
  border-radius: var(--radius); border: 1px solid var(--line); background: var(--surface);
}
/* 竖版：图按宽度铺满、整体垂直居中，避免图上下留出两条空白 */
.shot-v { flex: none; }
.shot-v .shot-img { flex: none; }
/* 横版：截图多为竖长条，铺满 16:9 会两侧留大片空底 → 改左右分栏，文字在左、图在右 */
.shot-2col {
  flex: 1; min-height: 0; display: grid;
  grid-template-columns: 0.88fr 1.12fr; gap: 48px; align-items: center;
}
.shot-2col .shot-copy { display: flex; flex-direction: column; gap: 26px; }
.shot-2col .shot-copy h2 { font-size: 54px; }
.shot-2col .shot-img { height: 100%; }
.shot-2col .shot-img img { max-height: 100%; }
.shot-cap { font-size: var(--fs-cap); color: var(--muted); }
.quote {
  padding: var(--pad-quote); border-left: 4px solid var(--accent);
  background: rgba(255,255,255,0.03); border-radius: 0 16px 16px 0;
  font-size: var(--fs-quote); line-height: 1.45; color: var(--text);
}
.steps { list-style: none; display: flex; flex-direction: column; gap: var(--gap-m); }
.steps li {
  display: grid; grid-template-columns: var(--bullet-n) 1fr; gap: var(--gap-s);
  align-items: start; font-size: var(--fs-body); line-height: 1.45;
}
.steps .n {
  width: var(--bullet-n); height: var(--bullet-n); border-radius: 50%;
  display: grid; place-items: center; font-family: var(--mono);
  font-size: var(--fs-num); color: var(--bg); background: var(--accent);
}
.cta { display: flex; flex-direction: column; gap: var(--gap-m); }
.cta-row { display: flex; flex-wrap: wrap; gap: var(--gap-s); }
.chip {
  font-size: var(--fs-chip); color: var(--text);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 999px; padding: var(--pad-chip) var(--pad-chip-x);
}
"""


CSS_16x9 = (
    TOKENS
    + """
.slide { width: 1920px; height: 1080px; padding: 64px 96px 56px; --grid: 48px; --gap-s: 16px; --gap-m: 26px; --gap-l: 40px; --mark: 30px; --fs-mast: 24px; --fs-tag: 19px; --pad-tag: 8px; --pad-tag-x: 16px; --fs-foot: 20px; --fs-h1: 82px; --fs-h2: 60px; --fs-lead: 36px; --fs-body: 34px; --fs-num: 18px; --fs-cap: 24px; --fs-quote: 42px; --fs-kicker: 20px; --fs-chip: 26px; --pad-chip: 10px; --pad-chip-x: 22px; --bullet-n: 40px; --radius: 20px; --pad-quote: 32px 36px; }
"""
    + _common()
)

CSS_3x4 = (
    TOKENS
    + """
.slide { width: 1080px; height: 1440px; padding: 72px 72px 60px; --grid: 40px; --gap-s: 14px; --gap-m: 26px; --gap-l: 36px; --mark: 30px; --fs-mast: 24px; --fs-tag: 19px; --pad-tag: 8px; --pad-tag-x: 16px; --fs-foot: 20px; --fs-h1: 68px; --fs-h2: 52px; --fs-lead: 34px; --fs-body: 34px; --fs-num: 18px; --fs-cap: 26px; --fs-quote: 40px; --fs-kicker: 20px; --fs-chip: 26px; --pad-chip: 10px; --pad-chip-x: 22px; --bullet-n: 40px; --radius: 20px; --pad-quote: 30px 32px; }
"""
    + _common()
)

#: 画幅名 → (CSS, 宽, 高, 字幕样式)
FORMATS = {
    "16x9": {
        "css": CSS_16x9,
        "width": 1920,
        "height": 1080,
        # 字幕压在画面底部，避开 .foot；数字是真实像素（ASS 的 PlayRes = 画面尺寸）
        # max_em = 每行最多多少个「字宽」；中文无空格，libass 不会自己断行，这里预折
        "subtitle": {
            "style": "Daily",
            "font": "Microsoft YaHei",
            "size": 46,
            "margin_h": 140,
            "margin_v": 140,
            "max_em": 33,
        },
    },
    "3x4": {
        "css": CSS_3x4,
        "width": 1080,
        "height": 1440,
        "subtitle": {
            "style": "Daily",
            "font": "Microsoft YaHei",
            "size": 44,
            "margin_h": 60,
            "margin_v": 150,
            "max_em": 20,
        },
    },
}
