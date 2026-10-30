import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Exercise the real overlay and batch callbacks with an in-memory draft atom. */
function createBatch(options = {}) {
	const questions = options.questions ?? [
		{ id: "first", type: "select", question: "First", options: ["A", "B"] },
		{ id: "second", type: "confirm", question: "Second" },
		{ id: "last", type: options.lastType ?? "input", question: "Last", options: ["A", "B"] },
	];
	const key = "session:agent:1:request";
	let draft = { key, batch: { answers: options.answers ?? {}, labels: {}, customAnswerIds: [], inputValues: { last: options.text ?? "last answer" }, currentTab: options.currentTab ?? questions.length - 1, expanded: true } };
	const responses = [];
	const family = Object.assign((value) => value, { remove() {} });
	const stubs = {
		react: { useEffect() {}, useMemo: (read) => read(), useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] },
		jotai: {
			useAtom: () => [
				draft,
				(update) => {
					draft = typeof update === "function" ? update(draft) : update;
				},
			],
		},
		"motion/react": { useReducedMotion: () => true, AnimatePresence: "presence", motion: { div: "motion-div" } },
		"lucide-react": { Check: "check", ClipboardList: "clipboard" },
		"../../atoms/ask-draft-atoms": { askDraftBySessionRequestAtomFamily: family },
		"../../i18n": { t: (value) => value },
		"../motion/draw-check": { DrawCheck: "draw-check" },
		"./SecurityConfirmCard": { SecurityConfirmCard: "security-card" },
		...Object.fromEntries(
			[
				["button", "Button"],
				["input", "Input"],
				["textarea", "Textarea"],
				["approval-card", "ApprovalCard"],
				["prompt-tooltip", "PromptTooltip"],
			].map(([file, name]) => [`../ui-shadcn/${file}`, { [name]: file }]),
		),
	};
	const { SessionRuntimeUiOverlay } = loadTsCommonJs("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", { stubs });
	const request = { agentId: "agent", requestId: "request", method: "batch_ask", title: "Batch", batchQuestions: questions, batchReview: options.review ?? false };
	const props = {
		sessionId: "session",
		runtime: { agentId: "agent", runtimeGeneration: 1, status: "running" },
		ui: { agentId: "agent", runtimeGeneration: 1, requests: { request: { status: "pending", request } } },
		responder: {
			async respond(_request, response) {
				responses.push(response);
				return true;
			},
		},
	};
	return {
		responses,
		get draft() {
			return draft.batch;
		},
		render() {
			const node = SessionRuntimeUiOverlay(props);
			return node.type(node.props);
		},
	};
}

/** Search rendered React elements without replacing the production event handlers. */
function findElement(node, predicate) {
	if (Array.isArray(node)) return node.map((child) => findElement(child, predicate)).find(Boolean);
	if (!node || typeof node !== "object") return undefined;
	if (predicate(node)) return node;
	return findElement(node.props?.children, predicate);
}

function question(batch) {
	const node = findElement(batch.render(), (element) => typeof element.props?.onAnswer === "function");
	assert.ok(node, "the batch must render its current question");
	return node.props;
}

for (const type of ["input", "select", "confirm"]) {
	test(`last ${type} answer cannot submit earlier unanswered questions`, () => {
		const batch = createBatch({ lastType: type });
		const current = question(batch);
		if (type === "input") current.onSubmitInput();
		else current.onAnswer(type === "confirm" ? false : "A");
		assert.equal(batch.responses.length, 0);
		assert.equal(batch.draft.currentTab, 0);
		assert.equal(batch.draft.answers.last, type === "input" ? "last answer" : type === "confirm" ? false : "A");
	});

	test(`first completion of last ${type} includes its new answer and accepts false`, () => {
		const batch = createBatch({ lastType: type, answers: { first: "A", second: false } });
		const current = question(batch);
		if (type === "input") current.onSubmitInput();
		else current.onAnswer(type === "confirm" ? false : "B");
		assert.equal(batch.responses.length, 1);
		const result = JSON.parse(batch.responses[0].value).answers;
		assert.equal(result[1].value, false);
		assert.equal(result[2].value, type === "input" ? "last answer" : type === "confirm" ? false : "B");
	});
}

test("incomplete submission selects the first missing answer and keeps earlier answers", () => {
	const batch = createBatch({ answers: { first: "B" } });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 1);
	assert.equal(batch.draft.answers.first, "B");
	assert.equal(batch.draft.answers.last, "last answer");
});

test("an empty multi-select remains unanswered", () => {
	const batch = createBatch({
		questions: [
			{ id: "first", type: "multi_select", question: "First", options: ["A"] },
			{ id: "last", type: "input", question: "Last" },
		],
		answers: { first: [] },
	});
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 0);
});

test("single-question first submission is not blocked by the previous draft", () => {
	const batch = createBatch({ questions: [{ id: "last", type: "input", question: "Only" }] });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 1);
	assert.equal(JSON.parse(batch.responses[0].value).answers[0].value, "last answer");
});

test("whitespace-only input does not complete the question", () => {
	const batch = createBatch({ answers: { first: "A", second: false }, text: "   " });
	assert.equal(question(batch).onSubmitInput(), false);
	assert.equal(batch.responses.length, 0);
});

test("review mode still waits for its explicit submit action", () => {
	const batch = createBatch({ review: true, answers: { first: "A", second: false } });
	question(batch).onSubmitInput();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 3);
	const submit = findElement(batch.render(), (node) => node.type === "button" && node.props.children === "ask.batchSubmitAll");
	assert.ok(submit);
	assert.equal(submit.props.disabled, false);
	submit.props.onClick();
	assert.equal(batch.responses.length, 1);
	assert.equal(JSON.parse(batch.responses[0].value).answers[2].value, "last answer");
});

test("an incomplete review cannot submit all answers", () => {
	const batch = createBatch({ review: true });
	question(batch).onSubmitInput();
	const submit = findElement(batch.render(), (node) => node.type === "button" && node.props.children === "ask.batchSubmitAll");
	assert.ok(submit);
	assert.equal(submit.props.disabled, true);
	// Also exercise the shared handler directly, independent of the button's disabled state.
	submit.props.onClick();
	assert.equal(batch.responses.length, 0);
	assert.equal(batch.draft.currentTab, 0);
});

test("empty batches do not render a submit path", () => {
	const batch = createBatch({ questions: [] });
	assert.equal(batch.render(), null);
	assert.equal(batch.responses.length, 0);
});
