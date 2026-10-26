/**
 * 远端图片预览的落点判定。
 *
 * 边界很窄但很容易错：远端文本通道拒绝非 UTF-8 内容，凡是「用编辑器打开 PNG」的代码路径都会
 * 得到 `REMOTE_FILE_NOT_TEXT`——看起来像文件损坏，实际是选错了通道。这组用例把「什么算图片」
 * 钉成纯函数行为，并守住面板到预览组件的接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { imageMimeForPath, imageMimeOrBinary } = loadTsCommonJs("src/renderer/src/utils/imageMime.ts");

test("常见图片扩展名映射到对应 MIME，大小写与目录前缀都不影响", () => {
	for (const [path, mime] of [
		["logo.png", "image/png"],
		["a/b/PHOTO.JPG", "image/jpeg"],
		["shot.jpeg", "image/jpeg"],
		["anim.GIF", "image/gif"],
		["x.webp", "image/webp"],
		["x.bmp", "image/bmp"],
		["favicon.ico", "image/x-icon"],
		["x.avif", "image/avif"],
	]) {
		assert.equal(imageMimeForPath(path), mime, path);
	}
});

test("SVG 不进入图片预览分流：它是 UTF-8 文本，必须留在可编辑通道里", () => {
	assert.equal(imageMimeForPath("icon.svg"), undefined, "否则远端 svg 会被替换成只读预览，失去源码编辑");
	// 但作为 Blob 类型（差异页的 data-URL 预览）仍要给出正确 MIME。
	assert.equal(imageMimeOrBinary("icon.svg"), "image/svg+xml");
});

test("非图片与无扩展名的路径不当作图片（否则编辑器会把源码当图片打开）", () => {
	for (const path of ["main.ts", "README", "a.b/c", ".png", "archive.png.zip", "src/index.tsx"]) {
		assert.equal(imageMimeForPath(path), undefined, path);
		assert.equal(imageMimeOrBinary(path), "application/octet-stream", path);
	}
});

test("文件名里带点的目录不影响判定（只在文件名部分取扩展名）", () => {
	assert.equal(imageMimeForPath("assets.v2/README"), undefined);
	assert.equal(imageMimeForPath("assets.v2/cover.png"), "image/png");
});

test("编辑器按扩展名分流：图片走预览组件，文本仍走草稿编辑器", () => {
	const editor = readFileSync("src/renderer/src/components/workspace/RemoteFileEditor.tsx", "utf8");
	assert.match(editor, /imageMimeForPath\(props\.path\) !== undefined\) return <RemoteImagePreview/);
	assert.match(editor, /RemoteTextFileEditor/);
	// 预览组件必须走只读 base64 通道，而不是文本草稿通道。
	const preview = readFileSync("src/renderer/src/components/workspace/RemoteImagePreview.tsx", "utf8");
	assert.match(preview, /desktopApi\.remoteHosts\.readProjectFile\(/);
	assert.doesNotMatch(preview, /useRemoteFileDraft/);
	assert.match(preview, /data:\$\{mime\};base64,/);
});

test("差异查看器与预览共用同一份扩展名映射（不允许两份）", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 必须传**路径**：映射按扩展名查表，传裸扩展名（"png"）永远查不到 → 退化成 octet-stream。
	assert.match(viewer, /imageMimeOrBinary\(props\.filePath\)/);
	assert.doesNotMatch(viewer, /imageMimeOrBinary\(ext\)/);
	assert.doesNotMatch(viewer, /const map: Record<string, string> = \{\s*png:/, "旧的私有映射必须删掉");
});
