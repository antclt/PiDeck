import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildComposerEditorProps } = loadTsCommonJs("src/renderer/src/components/session/composer/tiptap/buildComposerEditorProps.ts");

/**
 * #455 输入框稳定性契约（源码级断言，真正的行为验证见 e2e）：
 * - useEditor 的 extensions / content / editorProps 必须是稳定引用，否则每次渲染都跑一次
 *   setOptions（view.setProps + updateState），合成期会重写 DOM 选区；
 * - composingRef 必须有 compositionend 之外的复位兜底（失焦 / 看门狗），否则永久卡 true，
 *   onUpdate 全部早退、draft atom 静默停止同步；
 * - 合成期跳过 options 同步时必须记 pending，结束后补跑（disabled 唯一生效路径就在那条 effect 上）。
 */
const editorSource = readFileSync("src/renderer/src/components/session/composer/useTipTapComposerEditor.ts", "utf8");

test("useEditor options are stable references (no setOptions on every render)", () => {
	assert.match(editorSource, /const extensions = useMemo\(\(\) => createComposerExtensions\(\), \[\]\)/);
	assert.match(editorSource, /const editorProps = useMemo\(\(\) => buildComposerEditorProps\(/);
	assert.match(editorSource, /const initialContentRef = useRef<ReturnType<typeof plainTextToComposerDoc> \| null>\(null\)/);
	// 传给 useEditor 的必须是稳定变量，不能再内联构造（内联 = 每次渲染新引用）
	assert.match(editorSource, /extensions,\s*\n\s*content: initialContentRef\.current,\s*\n\s*editorProps,/);
	assert.doesNotMatch(editorSource, /extensions: createComposerExtensions\(\)/);
});

test("composing flag has reset fallbacks beyond compositionend", () => {
	// 失焦打断合成：浏览器常常不再派发 compositionend
	assert.match(editorSource, /dom\.addEventListener\("blur", onBlur, true\)/);
	// 看门狗：以 ProseMirror 自己的 view.composing 为准，兜住「compositionend 从未到达」
	assert.match(editorSource, /if \(!editor\.view\.composing\) finishComposition\(\)/);
	assert.match(editorSource, /window\.setInterval\(/);
});

test("deferred options sync is recorded and flushed after composition", () => {
	// 合成期跳过 setOptions 时必须记 pending，否则 disabled / placeholder 被永久丢弃
	assert.match(editorSource, /if \(composingRef\.current\) \{\s*\n\s*pendingOptionsSyncRef\.current = true;\s*\n\s*return;\s*\n\s*\}/);
	assert.match(editorSource, /if \(pendingOptionsSyncRef\.current\) \{/);
	// setEditable 是 disabled 的唯一生效路径（useEditor 的 editable 被库内 onRender 写死），必须保留
	assert.match(editorSource, /editor\.setEditable\(!disabled\)/);
	assert.match(editorSource, /editor\.setEditable\(!latest\.disabled\)/);
});

test("composition still suppresses draft emission and syncs once at the end", () => {
	assert.match(editorSource, /if \(composingRef\.current\) return;\s*\n\s*emitPlainText\(ed\)/);
	assert.match(editorSource, /syncEmptyClass\(editor\);\s*\n\s*emitPlainText\(editor\);/);
});

test("composer editor props: compositionstart/end 直接置位同一个 composingRef", () => {
	// composingRef 是「拦住 draft 失同步」的唯一开关：handleDOMEvents 必须是同一个引用，
	// 否则 hook 里的复位/看门狗看到的是另一份状态，永远对不上。
	const composingRef = { current: false };
	const props = buildComposerEditorProps({ composingRef }, { className: "bang", placeholder: "输入" });
	props.handleDOMEvents.compositionstart();
	assert.equal(composingRef.current, true);
	props.handleDOMEvents.compositionend();
	assert.equal(composingRef.current, false);
});

test("composer editor props: placeholder / disabled 会增删 attributes 键（setOptions 重写选区的触发器）", () => {
	const composingRef = { current: false };
	const withPlaceholder = buildComposerEditorProps({ composingRef }, { className: "bang", placeholder: "输入", disabled: true });
	assert.equal(withPlaceholder.attributes["data-placeholder"], "输入");
	assert.equal(withPlaceholder.attributes["aria-disabled"], "true");
	// 键集合变化 → NodeType.attrs 按值比较不等 → updateDoc 恒真 → DOM 选区被拉回 state。
	// 所以打字期间 editorProps 必须是稳定引用（useMemo 依赖里带上这三个值）。
	const without = buildComposerEditorProps({ composingRef }, { className: "bang" });
	assert.equal("data-placeholder" in without.attributes, false);
	assert.equal("aria-disabled" in without.attributes, false);
});
