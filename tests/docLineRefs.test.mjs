import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 文档里的 `文件:行号` 引用必须为 0。
 *
 * 为什么做成常驻判据：这一批文档（调研报告、方案、夹具说明）曾被本补丁改了代码之后整体失效——
 * `TurnRow.tsx` 拆成 `TurnRow.tsx` + `TurnStepRow.tsx` + `TurnRowActions.tsx`、`timeline.css` 插了 60+ 行，
 * 于是文里一百多处 `xxx.tsx:271-350` 全部指到无关代码。失效的行号比没有行号更坏：
 * 它指着一行真实存在的代码，读者以为那是证据。
 *
 * 判据只认「文件名（带这些扩展名）+ 行号」这种句法。两种形态都要抓：
 *   `TurnRow.tsx:271-350`（冒号形）
 *   `TurnRow.tsx 353`（空格形 —— 上一次性修复脚本只处理冒号形，反而造出了这种更坏的新形态）
 * 故意不抓裸区间（`(324-334)`）与纯数字（`320ms`、`15px`、`1.1.20`）：它们合法且量大，
 * 抓了会逼人写一堆例外，判据迟早被人关掉。
 */

const DOCS = ["docs/timeline-process-display-research.md", "docs/process-group-implementation-contract.md", "docs/virtualization-audit.md", "docs/web-mobile-viewport-height-plan.md", "tests/fixtures/ask-click-fixture.html"];

const LINE_REF = /[A-Za-z0-9_./-]+\.(?:tsx?|css|mjs|html)\s*[:,]?\s+?\d[\d,-]*|[A-Za-z0-9_./-]+\.(?:tsx?|css|mjs|html):\d[\d,-]*/g;
/** 从一段文本里挑出真引用（冒号形或「文件名 + 空格 + 数字」形）。 */
const scan = (text) => (text.match(LINE_REF) ?? []).filter((hit) => /:(?:\d)|(?:\.(?:tsx?|css|mjs|html)\s+\d)/.test(hit));

test("文档不写行号（写成行号就会随代码漂移，而失效的行号比没有行号更坏）", () => {
	const offenders = [];
	for (const rel of DOCS) {
		const text = readFileSync(rel, "utf8");
		text.split("\n").forEach((line, index) => {
			const hits = scan(line);
			if (hits.length) offenders.push(rel + ":" + (index + 1) + "  " + hits.join(" | "));
		});
	}
	assert.deepEqual(offenders, [], "这些行仍在写行号：改成只留文件名，或用 grep -n 现查");
});

test("判据自带合格样本与触发样本（先证明它会红）", () => {
	assert.deepEqual(scan("见 `TurnRow.tsx:271-350` 处"), ["TurnRow.tsx:271-350"], "冒号形必须被抓到");
	assert.deepEqual(scan("见 `TurnRow.tsx 353` 处"), ["TurnRow.tsx 353"], "空格形必须被抓到");
	assert.deepEqual(scan("见 `turn/TurnStepRow.tsx:12`"), ["turn/TurnStepRow.tsx:12"], "带目录的文件名也要抓到");
	assert.deepEqual(scan("耗时 320ms、字号 15px、版本 1.1.20、提交 988c74d46"), [], "纯数字与版本号不得误判");
	assert.deepEqual(scan("见 `TurnRow.tsx`（用 grep -n 现查）"), [], "只写文件名是合法形态");
});
