import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Wallpaper Engine 视频壁纸加固（在第一期之上）：
 * - project.json 尾部 NUL 填充容错；
 * - 手选目录（Steam 根 / steamapps / workshop/content）归一化到 .../431960；
 * - 列表阶段 canPlayType 判定 + <video> error 回退到预览图或无壁纸并提示。
 */

const shared = loadTsCommonJs("src/shared/wallpaperEngine.ts");
const lib = loadTsCommonJs("src/main/wallpaperEngine/wallpaperEngineLibrary.ts", { globals: { Response, Request, ReadableStream, URL } });

test("project.json with trailing NUL padding (and BOM) still parses and lists", async () => {
	const raw = `\uFEFF${JSON.stringify({ title: "Padded", type: "video", file: "a.mp4" })}\0\0\0\n\0`;
	const item = shared.parseWallpaperEngineProject("42", raw);
	assert.equal(item?.title, "Padded");
	// 中间内容不被改动：字符串里的 \0 转义保持原样
	assert.equal(shared.parseWallpaperEngineProject("43", `${JSON.stringify({ title: "a\u0000b", type: "video", file: "a.mp4" })}\0`)?.title, "a\u0000b");
	const dir = mkdtempSync(join(tmpdir(), "we-nul-"));
	try {
		mkdirSync(join(dir, "42"));
		writeFileSync(join(dir, "42", "project.json"), raw);
		const result = await lib.listWallpaperEngineItems(dir);
		assert.deepEqual(
			Array.from(result.items, (i) => i.id),
			["42"],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
