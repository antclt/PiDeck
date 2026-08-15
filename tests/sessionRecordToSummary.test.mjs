import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionRecordToSummary } = loadTsCommonJs(
	"src/renderer/src/atoms/session-selectors.ts",
);

const baseRecord = {
	id: "session-1",
	projectId: "project-1",
	title: "pi-desktop DSH",
	source: "pi",
	environment: "native",
	status: "active",
	createdAt: 1000,
	updatedAt: 2000,
	preview: "",
	messageCount: 0,
};

test("pi 会话无 filePath 仍不投影（文件会话必须有路径）", () => {
	const summary = sessionRecordToSummary({ ...baseRecord, filePath: undefined });
	assert.equal(summary, undefined);
});

test("DSH 会话无 filePath 投影进侧栏列表（filePath 空串 + backend + dshSessionId）", () => {
	const summary = sessionRecordToSummary({
		...baseRecord,
		filePath: undefined,
		backend: "dsh",
		dshSessionId: "session-abc-123",
	});
	assert.ok(summary, "DSH 会话必须进列表");
	assert.equal(summary.id, "session-1");
	assert.equal(summary.filePath, "");
	assert.equal(summary.backend, "dsh");
	assert.equal(summary.dshSessionId, "session-abc-123");
	assert.equal(summary.name, "pi-desktop DSH");
});

test("有 filePath 的会话投影保持不变", () => {
	const summary = sessionRecordToSummary({
		...baseRecord,
		filePath: "C:\\work\\session.jsonl",
	});
	assert.ok(summary);
	assert.equal(summary.filePath, "C:\\work\\session.jsonl");
});
