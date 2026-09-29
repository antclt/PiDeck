import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const noop = () => {};
const hidden = () => null;
const passthrough = ({ children }) => children;

/** 渲染真实输入栏布局，只替换与位置无关的编辑器、进程桥和发送控制器。 */
function renderComposer(run, options = {}) {
	const portals = [];
	const target = options.target === undefined ? { dataset: { sessionId: "session-a" } } : options.target;
	const { ComposerArea } = loadTsCommonJs("src/renderer/src/components/session/ComposerArea.tsx", {
		stubs: {
			jotai: { useAtomValue: () => ({}) },
			"react-dom": {
				createPortal: (children, container) => {
					portals.push({ children, container });
					return null;
				},
			},
			"../../hooks/useSessionComposerController": {
				useSessionComposerController: () => ({
					draft: "保留的草稿",
					attachments: [],
					pasteFiles: { files: [] },
					editor: {},
					suggestions: {},
					pickers: {},
					modals: {},
					voice: {},
					sendState: { status: "idle" },
					delivery: { canSendQuickMessage: true, sendQuickMessage: noop },
					...options.composer,
				}),
			},
			"./ComposerParts": { ComposerBottomBar: hidden, ImagePreviewModal: hidden, PromptSuggestions: hidden },
			"./composer": { TipTapComposer: () => createElement("textarea", { "data-testid": "composer-editor", defaultValue: "保留的草稿" }) },
			"../app/SessionReferenceModal": { SessionReferenceModal: hidden },
			"./ComposerPanels": { ComposerAttachmentBar: hidden, ComposerSendControls: hidden, SessionDeliveryNotice: hidden },
			"./ComposerPickerHost": { ComposerPickerHost: hidden },
			"./SecurityControl": { SecurityControl: hidden },
			"./QuickMessageMenu": { QuickMessageMenu: hidden },
			"../../atoms/composer-atoms": { modelPendingByIdAtom: {} },
			"./ComposerRuntimeIntegrations": { ComposerRuntimeIntegrations: ({ children }) => children({}) },
			"./SessionPaneServices": { useSessionPaneServices: () => ({}) },
			"../../desktopApi": { desktopApi: {} },
			"../../rendererUtils": { COMPOSER_TEXT_MAX_HEIGHT: 320 },
			"./ComposerStatsLine": { ComposerStatsLine: hidden },
			"./ComposerWidgetLayout": { ComposerWidgetLayoutProvider: passthrough, useComposerWidgetLayoutValue: () => ({}) },
			"./VoiceTranscriptionControls": { VoiceTranscriptionControls: hidden },
			"../bridge/BridgeSlot": { BridgeWidgetSlot: hidden },
			"../../i18n": { t: (key) => key },
			"../ui-shadcn/button": { Button: ({ children, variant: _variant, size: _size, ...props }) => createElement("button", props, children) },
		},
	});
	const html = renderToStaticMarkup(
		createElement(ComposerArea, {
			sessionId: "session-a",
			replyActionMessages: run?.items.map((item) => item.message) ?? [],
			replyActionsTarget: target,
			replyActionsBlocked: options.blocked,
			widgets: createElement("section", { "data-testid": "session-todo-strip" }, "待办 4 完成"),
		}),
	);
	return { html, portals, target, actionsHtml: portals.map((portal) => renderToStaticMarkup(portal.children)).join("") };
}

const completedRun = {
	kind: "agent-run",
	id: "run-a",
	items: [{ kind: "message", message: { id: "answer-a", agentId: "agent-a", role: "assistant", text: "修改已完成，可以提交这些改动。", stopReason: "stop", timestamp: 2 } }],
	startedAt: 1,
	endedAt: 2,
	askWaitMs: 0,
	askPending: false,
};

test("快捷操作只投到本会话的消息末尾，不再位于输入栏或待办卡列", () => {
	const { html, portals, target, actionsHtml } = renderComposer(completedRun);
	assert.ok(!html.includes('data-testid="session-commit-suggestion-strip"'), "不能保留旧的输入栏建议条");
	assert.ok(!html.includes('data-testid="session-reply-action-strip"'));
	assert.equal(portals.length, 1);
	assert.equal(portals[0].container, target);
	assert.ok(actionsHtml.includes("commitSuggest.commit"));
	assert.ok(actionsHtml.includes("replySuggest.continue"));
	assert.ok(html.indexOf('data-testid="session-todo-strip"') < html.indexOf('data-testid="composer-editor"'));
});

test("没有最新回复时不显示建议，也不影响待办栏与输入框", () => {
	const { html, actionsHtml } = renderComposer(undefined);
	assert.equal(actionsHtml, "");
	assert.ok(html.includes('data-testid="session-todo-strip"'));
	assert.ok(html.includes('data-testid="composer-editor"'));
});

test("流式、投递中、投递未知和生图模式不提供快捷动作", () => {
	for (const composer of [{ isBusy: true }, { isStarting: true }, { sendState: { status: "sending" } }, { sendState: { status: "unknown" } }, { mode: "imagegen" }, { backend: "imagegen" }]) {
		assert.equal(renderComposer(completedRun, { composer }).actionsHtml, "");
	}
});

test("会话切换时不能把新会话操作投到上一栏的末尾", () => {
	assert.equal(renderComposer(completedRun, { target: { dataset: { sessionId: "session-b" } } }).portals.length, 0);
	assert.equal(renderComposer(completedRun, { target: null }).portals.length, 0);
});

test("Ask、重启或历史加载阻塞时隐藏回复操作", () => {
	assert.equal(renderComposer(completedRun, { blocked: true }).portals.length, 0);
});

test("回复操作沿用直发通道，不能替换输入框草稿", () => {
	const sent = [];
	const { html, portals } = renderComposer(completedRun, { composer: { delivery: { canSendQuickMessage: true, sendQuickMessage: (text) => sent.push(text) } } });
	for (const button of portals[0].children.props.children) button.props.onClick();
	assert.deepEqual(sent, ["commitSuggest.commitText", "commitSuggest.commitPushText", "replySuggest.continueText"]);
	assert.ok(html.includes("保留的草稿"));
});

test("发送不可用时所有回复操作都禁用", () => {
	const { portals } = renderComposer(completedRun, { composer: { delivery: { canSendQuickMessage: false, sendQuickMessage: noop } } });
	for (const button of portals[0].children.props.children) assert.equal(button.props.disabled, true);
});
