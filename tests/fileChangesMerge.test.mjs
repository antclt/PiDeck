import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRunFileChanges } from "../src/renderer/src/components/session/turn/fileChangesMerge.ts";

const file = (path, count, originalContent, content) => ({ path, count, originalContent, content });

test("mergeRunFileChanges: empty run returns full unchanged", () => {
	const full = [file("a.ts", 2, "old", "new")];
	assert.deepEqual(mergeRunFileChanges(full, []), full);
});

test("mergeRunFileChanges: new path from run is appended", () => {
	const full = [file("a.ts", 1, "", "A")];
	const merged = mergeRunFileChanges(full, [file("b.ts", 1, "", "B")]);
	assert.equal(merged.length, 2);
	assert.deepEqual(merged[1], file("b.ts", 1, "", "B"));
});

test("mergeRunFileChanges: existing path keeps full count but adopts run diff", () => {
	const full = [file("a.ts", 3, "old-v1", "new-v1")];
	const merged = mergeRunFileChanges(full, [file("a.ts", 1, "old-v2", "new-v2")]);
	assert.equal(merged.length, 1);
	// count 沿用全量（流式期避免重复计数），diff 用 run 最新
	assert.deepEqual(merged[0], file("a.ts", 3, "old-v2", "new-v2"));
});

test("mergeRunFileChanges: mixed new and existing paths", () => {
	const full = [file("a.ts", 1, "", "A"), file("b.ts", 2, "bo", "bn")];
	const merged = mergeRunFileChanges(full, [file("b.ts", 1, "bo2", "bn2"), file("c.ts", 1, "", "C")]);
	assert.deepEqual(
		merged.map((f) => f.path).sort(),
		["a.ts", "b.ts", "c.ts"],
	);
	const b = merged.find((f) => f.path === "b.ts");
	assert.deepEqual(b, file("b.ts", 2, "bo2", "bn2"));
	const c = merged.find((f) => f.path === "c.ts");
	assert.deepEqual(c, file("c.ts", 1, "", "C"));
});

test("mergeRunFileChanges: run wins over empty full", () => {
	const merged = mergeRunFileChanges([], [file("a.ts", 1, "", "A")]);
	assert.deepEqual(merged, [file("a.ts", 1, "", "A")]);
});
