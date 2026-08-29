/**
 * dist:win 包装脚本，支持按需指定打包格式。
 *
 * 用法：
 *   npm run dist:win              → 全格式：nsis + portable + zip
 *   npm run dist:win -- nsis      → 仅 NSIS 安装包
 *   npm run dist:win -- portable  → 仅便携 exe
 *   npm run dist:win -- zip       → 仅 zip
 *   npm run dist:win -- nsis portable  → 多个指定格式
 */
const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");

// npm run 会把 -- 后面的参数放到 process.argv 的 2..n
const args = process.argv.slice(2);
const formats = args.length > 0
  ? args.join(" ")
  : "nsis portable zip";

console.log(`[1/2] 打包代码…`);
execSync("npm run build", { cwd: root, stdio: "inherit", shell: true });

console.log(`\n[2/2] electron-builder --win ${formats} …`);
execSync(`npx electron-builder --win ${formats}`, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

// 发布提示：electron-builder 已配置 publish(provider: github)，打包会在 release/ 生成
// 平台 channel 元数据（Windows: latest.yml / macOS: latest-mac.yml / Linux: latest-linux.yml），
// 客户端无配额更新检查按平台读取对应文件。发布 GitHub Release 时，除安装包外必须
// 一并上传 channel 文件（每个平台自己的那个），否则该平台客户端自动更新会降级为
// atom/API 兑底路径。
console.log(`\n✅ 打包完成！产物在 release/ 目录下`);
const releaseDir = path.join(root, "release");
if (fs.existsSync(releaseDir)) {
  const files = fs.readdirSync(releaseDir)
    .filter((name) => /latest(-\w+)?\.yml$/.test(name) || !/\.(blockmap|yml)$/.test(name))
    .filter((name) => !name.startsWith("."));
  console.log(`\n发布 GitHub Release 时需上传以下文件（assets）：`);
  for (const name of files) console.log(`  - ${name}`);
  const ymlFiles = fs.readdirSync(releaseDir).filter((name) => /latest(-\w+)?\.yml$/.test(name));
  if (ymlFiles.length === 0) {
    console.warn(`\n⚠ 未找到 latest*.yml：请确认 build.publish 配置存在（provider: github）`);
  } else {
    console.log(`\n⚠ 不要漏掉 latest.yml：它是客户端无配额自动更新检查的版本元数据。`);
  }
}

