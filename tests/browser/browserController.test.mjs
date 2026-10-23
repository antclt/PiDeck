import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// Controller 的截图函数来自依赖 electron 的模块；测试里只需要一个空壳（截图路径不参与动作测试）。
const electronStub = { nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) } };
const { BrowserController } = loadTsCommonJs("src/main/browser/BrowserController.ts", { stubs: { electron: electronStub } });
const { BrowserAgentError } = loadTsCommonJs("src/main/browser/browserErrors.ts");

const META = { sessionId: "sess-1" };

function makeGuest(overrides = {}) {
	return {
		id: 7,
		isDestroyed: () => false,
		getURL: () => "https://example.com/",
		getTitle: () => "Example",
		executeJavaScript: async () => true,
		...overrides,
	};
}

function makeRegistry(guest) {
	return { resolve: () => (guest ? { guest, id: guest.id, url: guest.getURL(), title: guest.getTitle() } : null) };
}

function makeCdp(handler) {
	const calls = [];
	return {
		calls,
		withGuest: async (guest, run) =>
			run(async (method, params) => {
				calls.push({ method, params });
				return handler(method, params);
			}),
	};
}

function evaluateResult(value) {
	return { result: { value } };
}

const RESOLVED = { found: true, visible: true, disabled: false, name: "Go", tag: "button", rect: { x: 100, y: 200, width: 40, height: 20 } };

function makeController({ registry, cdp, gate = { check: async () => ({ allowed: true, reason: "auto_approve" }) } } = {}) {
	return new BrowserController({
		registry: registry ?? makeRegistry(makeGuest()),
		cdp: cdp ?? makeCdp(() => ({})),
		gate,
		capture: async () => ({ base64: "", mimeType: "image/jpeg", width: 1, height: 1, cssWidth: 1, cssHeight: 1, scaleFactor: 1, source: "cdp" }),
	});
}

async function rejectsWithCode(promise, code) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
		return true;
	});
}

test("browser_not_open when no guest is resolvable", async () => {
	const controller = makeController({ registry: { resolve: () => null } });
	await rejectsWithCode(controller.getState(), "browser_not_open");
	await rejectsWithCode(controller.snapshot(), "browser_not_open");
});

test("snapshot normalizes the page payload and assigns increasing snapshot ids", async () => {
	const cdp = makeCdp(() =>
		evaluateResult({
			url: "https://example.com/",
			title: "Example",
			viewport: { width: 800, height: 600 },
			scroll: { x: 0, y: 0 },
			elements: [{ ref: "e1", role: "button", name: "Go", tag: "button" }],
			totalElements: 1,
		}),
	);
	const controller = makeController({ cdp });
	const first = await controller.snapshot();
	assert.equal(first.snapshotId, 1);
	assert.match(first.text, /- button "Go" \[ref=e1\]/);
	assert.equal(first.totalElements, 1);
	const second = await controller.snapshot();
	assert.equal(second.snapshotId, 2);
});

test("stale refs, invisible elements and disabled elements are rejected before any input", async () => {
	const staleCdp = makeCdp(() => evaluateResult({ found: false }));
	const staleController = makeController({ cdp: staleCdp });
	await rejectsWithCode(staleController.click({ ref: "e1" }, META), "stale_ref");
	assert.equal(staleCdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0);

	const hiddenCdp = makeCdp(() => evaluateResult({ ...RESOLVED, visible: false }));
	await rejectsWithCode(makeController({ cdp: hiddenCdp }).click({ ref: "e1" }, META), "element_not_visible");

	const disabledCdp = makeCdp(() => evaluateResult({ ...RESOLVED, disabled: true }));
	await rejectsWithCode(makeController({ cdp: disabledCdp }).click({ ref: "e1" }, META), "element_disabled");
});

test("a denied approval gate stops the action and maps CUA reason to browser_disabled", async () => {
	const cdp = makeCdp(() => evaluateResult(RESOLVED));
	const gate = { check: async () => ({ allowed: false, reason: "cua_disabled" }) };
	const controller = makeController({ cdp, gate });
	await rejectsWithCode(controller.click({ ref: "e1" }, META), "browser_disabled");
	assert.equal(cdp.calls.filter((call) => call.method.startsWith("Input.")).length, 0, "no input when the gate denies");
});

test("click re-reads the rect after scrolling and dispatches a full mouse sequence", async () => {
	const cdp = makeCdp((method) => {
		if (method === "Runtime.evaluate") return evaluateResult(RESOLVED);
		return {};
	});
	const gate = {
		check: async (action, sessionId, detail) => {
			gateCalls.push({ action, sessionId, detail });
			return { allowed: true, reason: "auto_approve" };
		},
	};
	const gateCalls = [];
	const controller = makeController({ cdp, gate });
	const result = await controller.click({ ref: "e1" }, { sessionId: "sess-9", agentId: "agent-1" });
	assert.equal(result.gate, "auto_approve");
	assert.equal(gateCalls[0].action, "browser_click");
	assert.equal(gateCalls[0].sessionId, "sess-9");
	assert.equal(gateCalls[0].detail.ref, "e1");
	const inputCalls = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
	assert.deepEqual(
		inputCalls.map((call) => call.params.type),
		["mouseMoved", "mousePressed", "mouseReleased"],
	);
	assert.equal(inputCalls[1].params.x, 120);
	assert.equal(inputCalls[1].params.y, 210);
	assert.equal(inputCalls[1].params.clickCount, 1);
});

test("type focuses the element and inserts text; submit presses Enter", async () => {
	const cdp = makeCdp((method) => {
		if (method === "Runtime.evaluate") return evaluateResult(RESOLVED);
		return {};
	});
	const controller = makeController({ cdp });
	await controller.type({ ref: "e1", text: "hello", clear: true, submit: true }, META);
	const inserted = cdp.calls.filter((call) => call.method === "Input.insertText");
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].params.text, "hello");
	const keyDowns = cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
	assert.ok(keyDowns.some((call) => call.params.key === "Enter"));
});

test("navigate rejects non-http URLs before asking for approval", async () => {
	let gateCalls = 0;
	const cdp = makeCdp(() => evaluateResult(RESOLVED));
	const controller = makeController({
		cdp,
		gate: {
			check: async () => {
				gateCalls += 1;
				return { allowed: true };
			},
		},
	});
	await rejectsWithCode(controller.navigate({ url: "file:///etc/passwd" }, META), "url_not_allowed");
	assert.equal(gateCalls, 0);
});

test("unsupported keys fail with unsupported_key", async () => {
	const controller = makeController();
	await rejectsWithCode(controller.pressKey({ key: "f13" }, META), "unsupported_key");
});

test("scroll falls back to executeJavaScript when CDP is busy and reports degraded", async () => {
	const cdp = makeCdp((method) => {
		if (method === "Runtime.evaluate") return evaluateResult({ viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } });
		throw new BrowserAgentError("cdp_busy", "debugger already attached");
	});
	const controller = makeController({ cdp });
	const result = await controller.scroll({ deltaY: -200 }, META);
	assert.equal(result.degraded, true);
});
