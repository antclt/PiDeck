/**
 * 生图参数解析：OpenAI WxH 与火山 1K/2K/4K；watermark 只在 Ark 端点发出。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { describe } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadParams() {
	const source = ts.transpileModule(readFileSync("src/shared/imageGenParams.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "imageGenParams.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(source, { module, exports: module.exports }, { filename: "imageGenParams.ts" });
	return module.exports;
}

describe("parseImageGenSize", () => {
	test("accepts OpenAI pixel sizes and Volc 1K-4K", () => {
		const { parseImageGenSize } = loadParams();
		assert.equal(parseImageGenSize("1024x1024"), "1024x1024");
		assert.equal(parseImageGenSize(" 2k "), "2K");
		assert.equal(parseImageGenSize("4K"), "4K");
		assert.equal(parseImageGenSize("2048x2048"), "2048x2048");
		assert.equal(parseImageGenSize("auto"), null);
		assert.equal(parseImageGenSize("1024"), null);
		assert.equal(parseImageGenSize(""), null);
	});
});

describe("buildImageGenApiBody", () => {
	test("omits watermark on OpenAI-style endpoints", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "gpt-image-1",
			prompt: "cat",
			baseUrl: "https://api.openai.com/v1/images/generations",
			size: "1024x1024",
			watermark: true,
		});
		assert.equal(body.size, "1024x1024");
		assert.equal("watermark" in body, false);
		assert.equal("output_format" in body, false);
	});

	test("includes watermark and output_format on Ark /api/v3 endpoints", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "doubao-seedream",
			prompt: "cat",
			baseUrl: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
			size: "2K",
			watermark: false,
			outputFormat: "jpeg",
		});
		assert.equal(body.size, "2K");
		assert.equal(body.watermark, false);
		assert.equal(body.output_format, "jpeg");
	});
});

describe("parseImageGenOutputFormat", () => {
	test("normalizes jpg to jpeg and rejects unknown", () => {
		const { parseImageGenOutputFormat } = loadParams();
		assert.equal(parseImageGenOutputFormat("PNG"), "png");
		assert.equal(parseImageGenOutputFormat("jpg"), "jpeg");
		assert.equal(parseImageGenOutputFormat("webp", null), null);
	});
});
