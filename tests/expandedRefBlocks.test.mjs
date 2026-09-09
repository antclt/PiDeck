import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	parseExpandedRefBlocks,
	replaceExpandedRefBlocksWithLabels,
	formatPromptTemplateBlock,
} = loadTsCommonJs("src/shared/expandedRefBlocks.ts");

function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

const SAMPLE =
	'<quoted_context label="引用A" message_id="m1">\nA 全文\n</quoted_context>\n\n' +
	'<referenced_session name="会话B">\n[User]: x\n</referenced_session>\n\n' +
	'<skill name="cv-writer">\n指令正文\n</skill>\n\n' +
	formatPromptTemplateBlock("review", "模板正文") +
	"\n\n@src/a.ts 帮我看下";

/**
 * 主进程 / 渲染进程共用一份自包含块解析（shared/expandedRefBlocks）。
 * 这里直接锁 shared 模块的对外契约：四类块都能折叠成 label，且顺序不变。
 */
test("shared expandedRefBlocks folds all four block kinds in place", () => {
	assertJsonEqual(
		parseExpandedRefBlocks(SAMPLE).map((block) =>
			block.kind === "session" ? block.name : block.label,
		),
		["引用A", "会话B", "skill:cv-writer", "review"],
	);

	const folded = replaceExpandedRefBlocksWithLabels(SAMPLE);
	// 原位替换：只把块换成 label，原有 \n\n 分隔保持不变（侧栏 preview 等仍保留段落结构）
	assert.equal(
		folded,
		"❝引用A\n\n&会话B\n\n/skill:cv-writer\n\n/review\n\n@src/a.ts 帮我看下",
	);
	// 不能再漏出任何 XML 标签
	for (const tag of ["<quoted_context", "<referenced_session", "<skill", "<prompt_template"]) {
		assert.ok(!folded.includes(tag), `folded text must not contain ${tag}`);
	}
});

test("shared expandedRefBlocks leaves plain text untouched (zero-cost fast path)", () => {
	assert.equal(replaceExpandedRefBlocksWithLabels("普通消息"), "普通消息");
	assertJsonEqual(parseExpandedRefBlocks("普通消息"), []);
});

/**
 * 纯文本出口契约（回归）：消息文本里的自包含块是给模型读的上下文，任何面向人的
 * 文本出口都必须先折叠，否则会露出 <quoted_context …> 原文。
 * 气泡 / 复制 / 队列预览已覆盖；这里锁住其余五个曾漏出的出口。
 */
test("every plain-text surface folds self-contained reference blocks", () => {
	const surfaces = {
		"子代理转录（pi）": "src/renderer/src/components/session/SessionSubagentsStrip.tsx",
		"子代理转录（DSH）": "src/renderer/src/components/session/DshAgentToolsPanel.tsx",
		"会话定位轴标题": "src/renderer/src/components/app/AppUtils.ts",
		"侧栏会话 preview（主进程）": "src/main/sessions/SessionScanner.ts",
		"Web 端消息渲染（主进程）": "src/main/web/WebServiceManager.ts",
	};
	for (const [label, file] of Object.entries(surfaces)) {
		const source = readFileSync(file, "utf8");
		assert.match(
			source,
			/replaceExpandedRefBlocksWithLabels/,
			`${label} must fold reference blocks before rendering plain text (${file})`,
		);
	}
});
