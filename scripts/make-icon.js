const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { Icns, IcnsImage } = require('@fiahfy/icns');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default ?? pngToIcoModule;

// 打包标必须是矢量几何跳蛛（与 BrandMarkSvg 同源）。嵌 PNG 的旧稿会在小尺寸糊、圆角漏白。
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');
if (svg.includes('data:image/png')) {
  throw new Error('build/icon.svg must stay a vector mark; do not embed a PNG');
}
if (!svg.includes('<ellipse cx="60" cy="50"')) {
  throw new Error('build/icon.svg must keep the BrandMarkSvg geometry');
}

const out = path.join(__dirname, '..', 'build');
const iconsDir = path.join(out, 'icons');
const iconContentRatio = 0.875;
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icnsSources = [
  [16, 'icp4'],
  [32, 'icp5'],
  [32, 'ic11'],
  [64, 'icp6'],
  [64, 'ic12'],
  [128, 'ic07'],
  [256, 'ic08'],
  [256, 'ic13'],
  [512, 'ic09'],
  [512, 'ic14'],
  [1024, 'ic10'],
];

async function renderPng(size, target) {
  let innerSize = Math.max(1, Math.round(size * iconContentRatio));
  if (innerSize > 1) innerSize -= innerSize % 2;
  const icon = await sharp(Buffer.from(svg))
    .resize(innerSize, innerSize)
    .png()
    .toBuffer();

  // Dock/Finder 会优先使用 icns 内的小尺寸图；如果小尺寸直接铺满画布，
  // 视觉上会比系统应用图标大一圈。所有平台图标都统一保留 6.25% 留白。
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: icon,
        left: Math.floor((size - innerSize) / 2),
        top: Math.floor((size - innerSize) / 2),
      },
    ])
    .png()
    .toFile(target);
}

async function writeIcns(target) {
  const icns = new Icns();
  for (const [size, osType] of icnsSources) {
    const file = path.join(iconsDir, `${size}x${size}.png`);
    const buffer = await fs.promises.readFile(file);
    icns.append(IcnsImage.fromPNG(buffer, osType));
  }
  await fs.promises.writeFile(target, icns.data);

  const header = await fs.promises.readFile(target, { encoding: null });
  if (header.subarray(0, 4).toString('ascii') !== 'icns') {
    throw new Error('generated icon.icns is invalid: missing icns file header');
  }
}

async function main() {
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.svg'), svg);

  // electron-builder 在 Linux 下会从 build/icons 读取多尺寸 PNG；
  // Windows 安装包需要 .ico，macOS 需要 .icns。显式生成这些格式，
  // 避免只存在 SVG 时各平台回退到默认 Electron 图标。
  await Promise.all(
    pngSizes.map(size => renderPng(size, path.join(iconsDir, `${size}x${size}.png`))),
  );

  await fs.promises.copyFile(path.join(iconsDir, '512x512.png'), path.join(out, 'icon.png'));
  const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(size => path.join(iconsDir, `${size}x${size}.png`)));
  await fs.promises.writeFile(path.join(out, 'icon.ico'), ico);
  await writeIcns(path.join(out, 'icon.icns'));

  // 应用内侧栏/空态用同一枚正式标；不要直接拷系统 512（含 Dock 留白），按 SVG 铺满导出。
  const rendererMark = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'brand-mark.png');
  await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(rendererMark);

  console.log('wrote build/icon.svg, build/icon.png, build/icon.ico, build/icon.icns, build/icons/*.png and src/renderer/src/assets/brand-mark.png');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
