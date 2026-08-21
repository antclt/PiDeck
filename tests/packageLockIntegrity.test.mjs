import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
const ALLOWED_TARBALL_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.npmmirror.com",
]);

function getLockedPackage(packagePath) {
  const lockedPackage = lockfile.packages[packagePath];
  assert.ok(lockedPackage, `missing ${packagePath} from package-lock.json`);
  return lockedPackage;
}

test("lockfile includes emnapi packages required by bundled native wasm dependencies", () => {
  const core = getLockedPackage("node_modules/@emnapi/core");
  const runtime = getLockedPackage("node_modules/@emnapi/runtime");

  assert.equal(core.version, "1.11.3");
  assert.equal(core.dependencies["@emnapi/wasi-threads"], "1.2.3");
  assert.equal(core.dependencies.tslib, "^2.4.0");
  assert.match(core.integrity, /^sha512-/);

  assert.equal(runtime.version, "1.11.3");
  assert.equal(runtime.dependencies.tslib, "^2.4.0");
  assert.match(runtime.integrity, /^sha512-/);
});

test("lockfile only resolves tarballs from approved npm registries", () => {
  for (const [packagePath, lockedPackage] of Object.entries(lockfile.packages)) {
    if (!lockedPackage || typeof lockedPackage.resolved !== "string") continue;
    if (!lockedPackage.resolved.startsWith("http")) continue;

    assert.ok(
      ALLOWED_TARBALL_HOSTS.has(new URL(lockedPackage.resolved).host),
      `${packagePath} resolves from an unapproved registry: ${lockedPackage.resolved}`,
    );
  }
});
