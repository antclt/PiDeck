/**
 * dist:fast —— 快速验证打包（日常迭代用）。
 *
 * 与 dist:win 的区别（即提速来源）：
 * 1. 跳过 tsc 全量类型检查 —— 类型正确性交给 IDE / npm run verify 兜底；
 * 2. compression=store —— electron-builder 不做 zlib 最高档压缩（maximum 是发布档）；
 * 3. 只打 nsis 单目标 —— 跳过 portable / zip 的重复压缩；
 * 4. PI_FAST_PACK=1 —— 跳过 afterPack 的 asar 解包清理/重打包（打包耗时大头）。
 *
 * 注意：发布正式版前必须跑完整 dist:win（maximum + 三格式 + 完整 afterPack 清理），
 * 且合并前照常执行 npm run typecheck，不要用本产物对外发布。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

console.log(`[1/3] 构建本地 packages（file: 依赖需要 lib/ 产物）…`);
execSync("npm run build:packages", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[2/3] electron-vite build（跳过 tsc 全量类型检查）…`);
execSync("npx electron-vite build", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[3/3] electron-builder --win nsis（compression=store + 跳过 asar 重打包）…`);
execSync("npx electron-builder --win nsis --config.compression=store", {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: { ...process.env, PI_FAST_PACK: "1" },
});

console.log(`\n✅ 快速打包完成！产物在 release/ 目录（*-setup.exe）。`);
