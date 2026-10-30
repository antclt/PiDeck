/**
 * TipTap Composer 编辑器生命周期：创建、受控同步、DOM 注册。
 * 视图层（TipTapComposer）只负责挂载 EditorContent。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import type { ComposerEditorProps } from "./types";
import { createComposerExtensions } from "./tiptap/createComposerExtensions";
import { buildComposerEditorProps, type ComposerEditorDomHandlers } from "./tiptap/buildComposerEditorProps";
import { plainTextToComposerDoc, serializeComposerEditorJson } from "./tiptap/plainTextCodec";
import { plainOffsetToPos, posToPlainOffset, registerComposerTipTapEditor } from "./tiptap/caretBridge";

export type UseTipTapComposerEditorArgs = Pick<ComposerEditorProps, "value" | "onChange" | "onCursorChange" | "onKeyDown" | "onPaste" | "onDrop" | "onDragOver" | "onChipClick" | "disabled" | "placeholder" | "className" | "caretRef" | "validCommandNames" | "validFilePaths" | "validSessionRefs" | "validQuotes"> & {
	hostRef: RefObject<HTMLDivElement | null>;
};

function syncEmptyClass(editor: Editor): void {
	editor.view.dom.classList.toggle("is-editor-empty", editor.isEmpty);
}

export function useTipTapComposerEditor(args: UseTipTapComposerEditorArgs): Editor | null {
	const { value, onChange, onCursorChange, onKeyDown, onPaste, onDrop, onDragOver, onChipClick, disabled, placeholder, className, caretRef, validCommandNames, validFilePaths, validSessionRefs, validQuotes, hostRef } = args;

	const whitelist = useMemo(() => ({ validCommandNames, validFilePaths, validSessionRefs, validQuotes }), [validCommandNames, validFilePaths, validSessionRefs, validQuotes]);
	const whitelistRef = useRef(whitelist);
	whitelistRef.current = whitelist;

	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onCursorChangeRef = useRef(onCursorChange);
	onCursorChangeRef.current = onCursorChange;
	const onKeyDownRef = useRef(onKeyDown);
	onKeyDownRef.current = onKeyDown;
	const onPasteRef = useRef(onPaste);
	onPasteRef.current = onPaste;
	const onDropRef = useRef(onDrop);
	onDropRef.current = onDrop;
	const onDragOverRef = useRef(onDragOver);
	onDragOverRef.current = onDragOver;
	const onChipClickRef = useRef(onChipClick);
	onChipClickRef.current = onChipClick;

	/**
	 * 合成状态：置位期间 onUpdate / onSelectionUpdate 一律早退（合成中的中间态不进草稿）。
	 * 它是「唯一能拦住 draft 失同步的开关」，所以必须有复位兜底 —— 只在 compositionend
	 * 复位的话，合成被外部打断（失焦 / 布局跳动 / 输入法切走）时会永久卡 true，
	 * 光标不再上报、draft atom 停止同步（issue #455 根因 C）。见下方合成收尾 effect。
	 */
	const composingRef = useRef(false);
	/** 合成期被推迟的 options 同步（setOptions / setEditable）：收尾时必须补跑一次。 */
	const pendingOptionsSyncRef = useRef(false);
	/** 最近一次由编辑器 onUpdate 推给父层的纯文本；用于区分「父层滞后」与「外部改草稿」。 */
	const lastEmittedRef = useRef(value);

	const emitPlainText = useCallback((editor: Editor) => {
		const next = serializeComposerEditorJson(editor.getJSON());
		lastEmittedRef.current = next;
		onChangeRef.current(next, posToPlainOffset(editor, editor.state.selection.from));
	}, []);

	// —— useEditor 的三个 options 必须稳定 ——
	// 单参数 useEditor 在库内是 deps=[]，onRender 每个渲染都跑 compareOptions；extensions /
	// content / editorProps 任一处是新引用就永不相等 ⇒ 每次渲染 setOptions() =
	// view.setProps() + view.updateState()，而 setProps 在选区与 state 不一致时会重写 DOM
	// 选区、打断合成（issue #455 根因 B-1）。三处必须一起稳定，少一处仍会每次渲染触发。
	const extensions = useMemo(() => createComposerExtensions(), []);
	// 初始文档只取第一帧：后续内容一律走受控同步（setContent）。content 跟着 value 走会让
	// 每次输入都产生新对象（doc/undefined 交替同样会退化成每次 +1）。
	const initialContentRef = useRef<ReturnType<typeof plainTextToComposerDoc> | null>(null);
	if (initialContentRef.current === null) initialContentRef.current = plainTextToComposerDoc(value, whitelist);
	// 回调只经 ref 转发，options 对象本身不随渲染变化。
	const editorHandlers = useMemo<ComposerEditorDomHandlers>(
		() => ({
			composingRef,
			onKeyDown: (event) => {
				onKeyDownRef.current?.(event as unknown as React.KeyboardEvent<HTMLDivElement>);
			},
			onPaste: (event) => {
				onPasteRef.current?.(event as unknown as React.ClipboardEvent<HTMLDivElement>);
			},
			onDrop: (event) => {
				onDropRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
			},
			onDragOver: (event) => {
				onDragOverRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
			},
			onChipClick: (chip) => onChipClickRef.current?.(chip),
		}),
		[],
	);
	// placeholder / disabled 会增删 attributes 的键与值：数值不变时引用也不变，打字期间
	// editorProps 恒定，setOptions 就不会把 DOM 选区拉回 state（issue #455 根因 B-2）。
	const editorProps = useMemo(() => buildComposerEditorProps(editorHandlers, { className, placeholder, disabled }), [editorHandlers, className, placeholder, disabled]);

	const editor = useEditor({
		immediatelyRender: false,
		editable: !disabled,
		extensions,
		content: initialContentRef.current,
		editorProps,
		onUpdate: ({ editor: ed }) => {
			syncEmptyClass(ed);
			if (composingRef.current) return;
			emitPlainText(ed);
		},
		onSelectionUpdate: ({ editor: ed }) => {
			if (composingRef.current) return;
			onCursorChangeRef.current(posToPlainOffset(ed, ed.state.selection.from));
		},
		onCreate: ({ editor: ed }) => {
			syncEmptyClass(ed);
		},
	});

	useEffect(() => {
		const dom = editor?.view?.dom as HTMLElement | undefined;
		if (!dom || !editor) return;
		registerComposerTipTapEditor(dom, editor);
		const host = hostRef.current;
		if (host) registerComposerTipTapEditor(host, editor);
		return () => {
			registerComposerTipTapEditor(dom, null);
			if (host) registerComposerTipTapEditor(host, null);
		};
	}, [editor, hostRef]);

	// 最新 options 的影子：合成收尾时要按「当下」的值补跑，不能依赖 effect 闭包。
	const latestOptionsRef = useRef({ disabled, editorProps });
	latestOptionsRef.current = { disabled, editorProps };

	/**
	 * 应用侧 options 同步 —— **不要删**：`useEditor({editable})` 在库内被 onRender 写死成
	 * `editor.isEditable`，`setEditable()` 是 `disabled` 唯一真正生效的路径。
	 *
	 * 合成期跳过：setOptions 会让 updateDoc 为真，prosemirror-view 随即将 DOM 选区按 state
	 * 重写，preedit 被打断（issue #455 根因 B-2）。跳过时必须记 pending，否则 disabled /
	 * 新 placeholder 这类只在合成期变化的配置会被永久丢弃（本 effect 是唯一写入点）。
	 */
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		if (composingRef.current) {
			pendingOptionsSyncRef.current = true;
			return;
		}
		pendingOptionsSyncRef.current = false;
		editor.setEditable(!disabled);
		editor.setOptions({ editorProps });
	}, [editor, disabled, editorProps]);

	// 合成收尾：补草稿同步 + 补跑被推迟的 options，并给 composingRef 加复位兜底。
	// 只在 compositionend 复位是不够的：合成被外部打断（失焦 / 布局跳动 / 输入法切走）时
	// 浏览器常常不再派发 compositionend，composingRef 会永久卡 true —— 之后 onUpdate 全部
	// 早退，屏幕上看到的文字与 draft atom 静默分叉（发送 / 排队 / 字数统计全用旧草稿）。
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const dom = editor.view.dom;
		let watchdog: number | null = null;
		const stopWatchdog = () => {
			if (watchdog !== null) {
				window.clearInterval(watchdog);
				watchdog = null;
			}
		};
		/** 收尾：复位 flag → 补跑推迟的 options → 补发最后一次合成结果。 */
		const finishComposition = () => {
			stopWatchdog();
			const wasComposing = composingRef.current;
			composingRef.current = false;
			// options 的补跑不看 composingRef：handleDOMEvents.compositionend 会先把 flag 置 false，
			// 这里若按 flag 早退，pending 的 options 就永远没人写。
			if (pendingOptionsSyncRef.current) {
				pendingOptionsSyncRef.current = false;
				const latest = latestOptionsRef.current;
				editor.setEditable(!latest.disabled);
				editor.setOptions({ editorProps: latest.editorProps });
			}
			if (!wasComposing) return;
			requestAnimationFrame(() => {
				if (composingRef.current || editor.isDestroyed) return;
				syncEmptyClass(editor);
				emitPlainText(editor);
			});
		};
		const onCompositionStart = () => {
			stopWatchdog();
			// 判据用 ProseMirror 自己的 view.composing：它在 compositionend 与失焦时都会被
			// 置 false，比「等 compositionend」可靠。
			watchdog = window.setInterval(() => {
				if (!editor.view.composing) finishComposition();
			}, 500);
		};
		const onCompositionEnd = () => finishComposition();
		// 失焦打断合成：浏览器多数情况下不再派发 compositionend，这里兜底收尾。
		const onBlur = () => finishComposition();
		dom.addEventListener("compositionstart", onCompositionStart);
		dom.addEventListener("compositionend", onCompositionEnd);
		dom.addEventListener("blur", onBlur, true);
		return () => {
			stopWatchdog();
			dom.removeEventListener("compositionstart", onCompositionStart);
			dom.removeEventListener("compositionend", onCompositionEnd);
			dom.removeEventListener("blur", onBlur, true);
		};
	}, [editor, emitPlainText]);

	/**
	 * 受控同步：只在父层 value 与「我们上次发出的文本」不一致时写回编辑器。
	 * 禁止用 editorText !== value 当条件——打字后父层尚未 re-render 时会把新输入打回旧草稿。
	 * 白名单变化只影响下次 setContent 解析，不作为同步触发依赖。
	 */
	/**
	 * 受控同步：只在父层 value 与「我们上次发出的文本」不一致时写回编辑器。
	 * 禁止用 editorText !== value 当条件——打字后父层尚未 re-render 时会把新输入打回旧草稿。
	 * 白名单变化只影响下次 setContent 解析，不作为同步触发依赖。
	 *
	 * 光标恢复是配对消费：写入方在事件处理器里同步 setDraft + 写 caretRef，
	 * 本 effect 只在 value 变化时重跑，因此同一趟 layout pass 里 value 就是请求
	 * 的 forValue。不匹配的请求 = 过期（要么其 value 从未渲染就被覆盖，要么写入
	 * 发生在 layout pass 之后），必须丢弃而非保留——否则会被下一次输入误用
	 * （旧实现：切换会话后第一次输入光标被重置回 draft.length）。
	 */
	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const pending = caretRef?.current;
		const needsContentSync = value !== lastEmittedRef.current;
		if (needsContentSync) {
			editor.commands.setContent(plainTextToComposerDoc(value, whitelistRef.current), {
				emitUpdate: false,
			});
			lastEmittedRef.current = value;
			syncEmptyClass(editor);
		}
		const caret = pending && pending.forValue === value ? pending.pos : null;
		if (typeof caret === "number" && caretRef) {
			// 程序化改动（引用插入/历史回填/运行时 editorText 恢复等）配对消费。
			editor.commands.setTextSelection(plainOffsetToPos(editor, Math.min(caret, value.length)));
			caretRef.current = null;
		} else if (needsContentSync) {
			// 外部同步（切换会话/草稿回填/发送清空）没有配对光标请求时，
			// setContent 会把选区映射到旧文档的任意位置；兜底恢复到文末。
			editor.commands.setTextSelection(plainOffsetToPos(editor, value.length));
		}
		if (pending && caretRef && pending.forValue !== value) {
			// 过期请求：随它所属的 value 已不可能再渲染，丢弃而非保留。
			caretRef.current = null;
		}
	}, [value, editor, caretRef]);

	return editor;
}
