import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 草稿收敛 / 预测 ghost 遮挡的契约（源码级断言，行为验证见 e2e 与手测）。
 *
 * 症状（用户 2026-10 反馈，ACP 会话最常撞到）：屏幕上看得见字，发送按钮还是灰的，
 * 输入预测的灰字还压在正文上；全选删除重打一次才恢复。
 * 根因是同一条：draft atom 只是编辑器 DOM 的投影，漏掉一次 onUpdate 就永久分叉。
 * 两道兜底：编辑器侧按秒对账补发；视图侧编辑器非空就不画 ghost。
 */

const editorSource = readFileSync("src/renderer/src/components/session/composer/useTipTapComposerEditor.ts", "utf8");
const composerSource = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("草稿收敛看门狗：文档与上次抛出的文本不一致就补发", () => {
	// 必须是 setInterval 对账，而不是只在事件里补发（漏发时没有任何事件会再来一次）
	assert.match(editorSource, /DRAFT_CONVERGENCE_INTERVAL_MS = \d+/);
	assert.match(editorSource, /const timer = window\.setInterval\(\(\) => \{[\s\S]*?serializeComposerEditorJson\(editor\.getJSON\(\)\) === lastEmittedRef\.current[\s\S]*?emitPlainText\(editor\);/);
});

test("合成收尾的补发判据是「文档 vs 上次抛出」，不是收尾时的 composing flag", () => {
	// PM 自己的 compositionend 处理器先注册（会先把 flag 置 false），且提交文本可能在
	// compositionend 之前就被 dispatch —— 按 flag 判会整段丢掉中文输入法的提交。
	assert.doesNotMatch(editorSource, /const wasComposing = composingRef\.current;/);
	assert.match(editorSource, /if \(serializeComposerEditorJson\(editor\.getJSON\(\)\) === lastEmittedRef\.current\) return;\s*\n\s*syncEmptyClass\(editor\);\s*\n\s*emitPlainText\(editor\);/);
});

test("合成期打上 is-composing，ghost 不压在 preedit 上", () => {
	assert.match(editorSource, /dom\.classList\.add\("is-composing"\)/);
	assert.match(editorSource, /dom\.classList\.remove\("is-composing"\)/);
	assert.match(css, /\.tiptap-composer-host\.is-composing \.composer-ghost \{\s*\n\s*display: none;/);
});

test("草稿收敛看门狗：合成中不写草稿，并复位卡住的 composing 标记", () => {
	// preedit 未提交时把中间态写进草稿会污染发送文本
	assert.match(editorSource, /if \(editor\.view\.composing\) return;\s*\n\s*composingRef\.current = false;/);
});

test("ghost 遮挡兜底：编辑器非空时不渲染预测灰字", () => {
	assert.match(composerSource, /className="composer-ghost /);
	assert.match(css, /\.tiptap-composer-host:has\(\.ProseMirror:not\(\.is-editor-empty\)\) \.composer-ghost \{\s*\n\s*display: none;/);
});
