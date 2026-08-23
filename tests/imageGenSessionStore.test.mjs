/**
 * ImageSessionStore 单测：生图草稿（无 pi 会话文件）的独立历史存储。
 * - 写读 round-trip（user+assistant 一轮）
 * - 多轮追加顺序保留（同会话多次生图）
 * - sessionId 白名单：非法 id（路径注入）静默拒绝，不落盘不读
 * - 损坏行跳过（单行损坏不阻断整段历史）
 * - 行数上限：超限只保留最新（防单会话失控）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadStore() {
	const source = ts.transpileModule(
		readFileSync("src/main/imagegen/ImageSessionStore.ts", "utf8"),
		{
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
			fileName: "ImageSessionStore.ts",
		},
	).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		source,
		{
			module,
			exports: module.exports,
			require: nodeRequire,
		},
		{ filename: "ImageSessionStore.ts" },
	);
	return module.exports;
}

function round(sessionId, n) {
	return [
		{
			id: `u-${n}`,
			agentId: "",
			role: "user",
			text: `prompt ${n}`,
			timestamp: 1700000000000 + n,
			images: n % 2 === 0 ? [{ type: "image", data: "QUJD", mimeType: "image/png" }] : undefined,
		},
		{
			id: `a-${n}`,
			agentId: "",
			role: "assistant",
			text: "",
			stopReason: "stop",
			timestamp: 1700000000000 + n,
			images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			meta: { imageGen: { status: "complete", prompt: `prompt ${n}` } },
		},
	];
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

test("append/read round-trip: 一轮生图记录（user 带参考图 + assistant 结果图）完整恢复", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-roundtrip-"));
	try {
		const store = new ImageSessionStore({ getStorePath: () => dir });
		// 第 2 轮（偶数）带参考图，验证参考图随 user 消息恢复
		await store.append(UUID_A, round(UUID_A, 2));
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "user");
		assert.equal(messages[0].text, "prompt 2");
		// vm 沙箱 realm 的对象原型不同，deepEqual 跨 realm 失败；用 JSON 序列化对比
		assert.equal(
			JSON.stringify(messages[0].images),
			JSON.stringify([{ type: "image", data: "QUJD", mimeType: "image/png" }]),
		);
		assert.equal(messages[1].role, "assistant");
		assert.equal(messages[1].meta.imageGen.status, "complete");
		assert.equal(messages[1].images[0].data, "REVG");
		// 明确落在 PiDeck userData 的 imagegen/sessions 下，文件名 = sessionId.jsonl
		const file = join(dir, `${UUID_A}.jsonl`);
		const raw = await readFile(file, "utf8");
		assert.equal(raw.split("\n").filter(Boolean).length, 2);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});

test("同一会话多轮追加：顺序保留（旧轮在前，新轮在后）", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-multi-"));
	try {
		const store = new ImageSessionStore({ getStorePath: () => dir });
		await store.append(UUID_A, round(UUID_A, 1));
		await store.append(UUID_A, round(UUID_A, 2));
		await store.append(UUID_A, round(UUID_A, 3));
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 6);
		assert.equal(
			JSON.stringify(messages.map((m) => m.text || m.meta.imageGen.prompt)),
			JSON.stringify([
				"prompt 1", "prompt 1", "prompt 2", "prompt 2", "prompt 3", "prompt 3",
			]),
		);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});

test("sessionId 白名单：非法 id（路径注入）静默拒绝，不落盘不读", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-inject-"));
	try {
		const store = new ImageSessionStore({ getStorePath: () => dir });
		const evil = "../../../escape.txt";
		await store.append(evil, round(UUID_A, 1));
		assert.equal(JSON.stringify(await store.readMessages(evil)), "[]");
		// 任何文件都不应被创建
		const names = await import("node:fs/promises").then(({ readdir }) => readdir(dir));
		assert.deepEqual(names, []);
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});

test("损坏行跳过：单行 JSON 损坏不阻断整段历史", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-corrupt-"));
	try {
		const file = join(dir, `${UUID_A}.jsonl`);
		await writeFile(
			file,
			`${JSON.stringify(round(UUID_A, 1)[0])}\n{ broken json\n${JSON.stringify(round(UUID_A, 1)[1])}\n`,
			"utf8",
		);
		const store = new ImageSessionStore({ getStorePath: () => dir });
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2);
		assert.equal(messages[0].role, "user");
		assert.equal(messages[1].role, "assistant");
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});

test("行数上限：超限只保留最新（防单会话失控）", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-cap-"));
	try {
		const store = new ImageSessionStore({ getStorePath: () => dir });
		// 2100 条（1050 轮）远超 MAX_MESSAGES=2000：只保留最新 2000 条
		const batches = [];
		for (let i = 0; i < 1050; i += 1) {
			const first = round(UUID_A, i)[0];
			const second = round(UUID_A, i)[1];
			batches.push([first, second]);
		}
		for (const batch of batches) await store.append(UUID_A, batch);
		const messages = await store.readMessages(UUID_A);
		assert.equal(messages.length, 2000);
		// 最新轮保留：最后一条是第 1050 轮的 assistant（meta.imageGen.prompt 区分）
		assert.equal(messages.at(-1).role, "assistant");
		assert.equal(messages.at(-1).meta.imageGen.prompt, "prompt 1049");
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});

test("无记录会话返回空数组（不抛错）", async () => {
	const { ImageSessionStore } = loadStore();
	const dir = await mkdtemp(join(tmpdir(), "pideck-imsess-empty-"));
	try {
		const store = new ImageSessionStore({ getStorePath: () => dir });
		assert.equal(JSON.stringify(await store.readMessages(UUID_B)), "[]");
	} finally {
		await import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }));
	}
});