/**
 * 开发验证打包（PiDeck Dev 通道）：固定输出到 release-dev/，不碰 release/（运行中的正式/便携进程
 * 锁着 release/ 下的 exe，electron-builder 写同名文件会报占用）。
 *
 * 产物与 dist:win:dev 同品牌（PiDeck-Dev-*、独立 appId）：本脚本是「开发验收包」，必须烘焙
 * dev 渠道标记（PIDECK_DEV_BUILD=1）并沿用 dist-dev.js 的差异配置——缺标记会以稳定渠道运行
 * （远端门禁 isDevChannelBuild 静默关闭、更新面指向稳定渠道）；缺 dev 配置则变成 stable 壳装
 * dev 代码，安装时会以稳定 appId 覆盖正式安装。
 *
 * 用法：
 *   npm run pack:dev                 → win-unpacked（最快，默认）
 *   npm run pack:dev -- portable     → 便携 exe 到 release-dev/
 *   npm run pack:dev -- nsis         → NSIS 安装包到 release-dev/
 *   npm run pack:dev -- dir portable
 *
 * 数据目录：dev 通道打包首启会弹数据模式选择（共用 PiDeck / 独立 channel-dev）；便携版数据 =
 * exe 同级 data/。想沿用旧数据，把 release/data 拷过去再删掉旧的坏 runtime，让新包重装修复版。
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { electronBuilderEnv } = require("./electronBuilderEnv.js");
const { buildDevConfig } = require("./dist-dev.js");

const root = path.resolve(__dirname, "..");

// 与 package.json 的 directories.output 区分开的独立 dev 输出目录。
// 如需换成别的名字，只改这里即可。
const DEV_OUTPUT_DIR = "release-dev";

const args = process.argv.slice(2);
// 默认 --dir（win-unpacked 目录，秒级验证）；传了格式参数就用传入的
const formats = args.length > 0 ? args.join(" ") : "--dir";

console.log(`[1/2] 打包代码（build 内置 runtime:pack + runtime:check）…`);
// 与 dist-dev.js 同口径：本脚本产物是「开发验收包」，build 期烘焙 dev 渠道标记。
// 缺了它产物会以稳定渠道运行——远端门禁（main 里 isDevChannelBuild 策略位）静默关闭、
// 更新面也指向稳定渠道；真机验收表现为「功能没启用」且难排查。
execSync("npm run build", {
	cwd: root,
	stdio: "inherit",
	shell: true,
	env: { ...process.env, PIDECK_DEV_BUILD: "1" },
});

console.log(`\n[2/2] electron-builder --win ${formats}（PiDeck Dev 配置）→ ${DEV_OUTPUT_DIR}/ …`);
// 差异配置走临时文件（--config 是完整配置、不与 package.json 合并），与 dist-dev.js 同一份 buildDevConfig；
// 输出目录仍指向 release-dev/，不碰 release/。
const configPath = path.join(os.tmpdir(), `pideck-dev-builder-config-${process.pid}.json`);
fs.writeFileSync(configPath, JSON.stringify(buildDevConfig(), null, "\t"));
try {
	execSync(`npx electron-builder --win ${formats} --config "${configPath}" --config.directories.output=${DEV_OUTPUT_DIR}`, { cwd: root, stdio: "inherit", shell: true, env: electronBuilderEnv() });
} finally {
	fs.rmSync(configPath, { force: true });
}

const outDir = path.join(root, DEV_OUTPUT_DIR);
console.log(`\n✅ 打包完成，产物在 ${DEV_OUTPUT_DIR}/`);
if (fs.existsSync(outDir)) {
	const files = fs.readdirSync(outDir).filter((name) => !/\.(blockmap|yml)$/.test(name) && !name.startsWith("."));
	for (const name of files) console.log(`  - ${name}`);
}
console.log(`\n提示：这是独立 dev 目录（PiDeck-Dev-* 产物），不影响 release/ 与正在运行的进程。`);
console.log(`验证通过、关掉旧进程后，正式产物仍用 npm run pack / npm run dist:win。`);
