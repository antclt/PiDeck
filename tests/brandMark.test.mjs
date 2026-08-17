import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const brandMark = "src/renderer/src/assets/brand-mark.png";
const packIcon = readFileSync("build/icon.svg", "utf8");
const siteIcon = readFileSync("docs-site/public/icon.svg", "utf8");
const makeIcon = readFileSync("scripts/make-icon.js", "utf8");
const brandMarkModule = readFileSync("src/renderer/src/components/app/brandMark.ts", "utf8");
const logo = readFileSync("src/renderer/src/components/app/JumpingSpiderLogo.tsx", "utf8");
const mark = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const lockup = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const boot = readFileSync("src/renderer/index.html", "utf8");
const webBrand = readFileSync("src/renderer/src/web/WebBrandLockup.tsx", "utf8");
const webTimeline = readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8");

test("pack and site icons stay the same vector mark as BrandMarkSvg", () => {
  for (const source of [packIcon, siteIcon]) {
    assert.match(source, /<ellipse cx="60" cy="50"/);
    assert.doesNotMatch(source, /data:image\/png/);
    assert.doesNotMatch(source, /M165\.29 165\.29/);
  }
  assert.match(makeIcon, /must stay a vector mark/);
});

test("in-app brand mark uses the official icon asset, not the cartoon spider paths", () => {
  assert.ok(existsSync(brandMark), "brand-mark.png must exist for Vite to pack");
  assert.match(brandMarkModule, /brand-mark\.png/);
  assert.match(logo, /brandMarkSrc/);
  assert.match(mark, /src=\{brandMarkSrc\}/);
  assert.match(lockup, /<JumpingSpiderLogo className="size-5 shrink-0" \/>/);
  assert.match(app, /<BrandMarkSvg size=\{120\} \/>/);
  assert.match(boot, /id="boot-mark-bg"/);
  assert.match(boot, /<ellipse cx="60" cy="50"/);
  assert.match(boot, /font-size: 40px/);
  assert.doesNotMatch(boot, /data:image\/png;base64,/);
  assert.match(webBrand, /<JumpingSpiderLogo className="size-5 shrink-0" \/>/);
  assert.match(webTimeline, /<JumpingSpiderLogo className="size-\[66px\]" \/>/);
  // 旧卡通线稿路径不应再出现在应用内品牌位
  for (const source of [logo, mark, lockup, app, boot, webBrand, webTimeline]) {
    assert.doesNotMatch(source, /M7\.5 15\.5C3\.5 14/);
  }
});
