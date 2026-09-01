import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");

/**
 * 回归（30b6954b）：新增 files:copy/files:move 时误删了 filesShowInFolder
 * handler，渲染层右键「在文件夹中显示」报 No handler registered。
 * 这里校验 shared/ipc.ts 中每个 files:* 通道都在 filesIpc.ts 注册了 handler，
 * 任何通道漏注册（或反向误删）都会让本测试先红。
 */
test("every files:* channel in shared/ipc.ts has a handler registered in filesIpc.ts", () => {
  // 从 ipc.ts 提取 files* 常量名（filesList / filesOpen / ...）
  const channelKeys = [...ipc.matchAll(/^\t(files\w+):\s*"files:/gm)].map((m) => m[1]);
  assert.ok(channelKeys.length >= 10, `expected files:* channels, got ${channelKeys.length}`);

  const missing = channelKeys.filter(
    (key) => !filesIpc.includes(`ipcChannels.${key}`),
  );
  assert.deepEqual(missing, [], "filesIpc.ts must register a handler for every files:* channel");
});

test("files:show-in-folder handler calls shell.showItemInFolder with Windows path conversion", () => {
  // 具体断言修复目标：handler 本体存在且保留 toWindowsPath 转换（WSL 路径可用）
  const block = filesIpc.match(
    /ipcMain\.handle\(\s*ipcChannels\.filesShowInFolder,[\s\S]*?shell\.showItemInFolder\(toWindowsPath\(path\)\);/,
  );
  assert.ok(block, "filesShowInFolder handler must call shell.showItemInFolder(toWindowsPath(path))");
});

test("files:list maps a deleted project root to a stable missing-directory error", () => {
  const block = filesIpc.match(
    /ipcMain\.handle\(\s*ipcChannels\.filesList,[\s\S]*?\n\t\);/,
  );
  assert.ok(block, "filesList handler should be discoverable");
  // 只转换根 listing 的 ENOENT；展开子目录的竞态错误保留原始上下文，便于定位具体路径。
  assert.match(block[0], /if \(!directory && \(error as NodeJS\.ErrnoException\)\.code === "ENOENT"\)/);
  assert.match(block[0], /throw new Error\("PROJECT_DIRECTORY_MISSING"\)/);
});
