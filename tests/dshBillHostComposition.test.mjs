import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * DSH 费用采集挂载护栏：hostEntry 必须把成熟的 dsh-bill 插进组合，
 * 且包在 dependencies 闭包里（打包后 utilityProcess 才能 require.resolve）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));

test("package.json depends on dsh-bill so electron-builder packs it", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["dsh-bill"], "dsh-bill must be a production dependency");
});

test("dsh-bill is resolvable from the app root (hostEntry require.resolve)", () => {
  const resolved = require.resolve("dsh-bill");
  assert.ok(existsSync(resolved), `resolved dsh-bill path missing: ${resolved}`);
  const pkg = JSON.parse(readFileSync(require.resolve("dsh-bill/package.json"), "utf8"));
  assert.equal(pkg.name, "dsh-bill");
});

test("hostEntry composition inserts the dsh-bill plugin row", () => {
  const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
  assert.match(src, /id:\s*"bill"/);
  assert.match(src, /require\.resolve\("dsh-bill"\)/);
});
