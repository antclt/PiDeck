import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findLoadedDirectory, mergeFileTreeChildren, hydrateExpandedFileTree } = loadTsCommonJs(
  "src/renderer/src/utils/fileTreeLazy.ts",
);

function dir(name, path, children) {
  return { name, path, relativePath: name, type: "directory", children, hasChildren: true };
}

function file(name, path) {
  return { name, path, relativePath: name, type: "file" };
}

test("findLoadedDirectory treats missing children as not loaded", () => {
  const tree = [dir("src", "/p/src")];
  assert.equal(findLoadedDirectory(tree, "/p/src"), undefined);
  const loaded = mergeFileTreeChildren(tree, "/p/src", []);
  assert.equal(findLoadedDirectory(loaded, "/p/src")?.name, "src");
});

test("mergeFileTreeChildren writes listing into the matching directory", () => {
  const tree = [dir("src", "/p/src"), file("README.md", "/p/README.md")];
  const next = mergeFileTreeChildren(tree, "/p/src", [file("App.tsx", "/p/src/App.tsx")]);
  assert.equal(next[0].children[0].name, "App.tsx");
  assert.equal(next[0].hasChildren, true);
  assert.equal(next[1].name, "README.md");
});

test("mergeFileTreeChildren leaves the tree unchanged when the directory is missing", () => {
  const tree = [file("README.md", "/p/README.md")];
  const next = mergeFileTreeChildren(tree, "/p/src", [file("App.tsx", "/p/src/App.tsx")]);
  assert.deepEqual(next, tree);
});

test("hydrateExpandedFileTree loads shorter parent paths first", async () => {
  const listed = [];
  const tree = [dir("src", "/p/src")];
  const hydrated = await hydrateExpandedFileTree(
    async (directory) => {
      listed.push(directory);
      if (directory === "/p/src") return [dir("components", "/p/src/components")];
      if (directory === "/p/src/components") return [file("Button.tsx", "/p/src/components/Button.tsx")];
      return [];
    },
    tree,
    ["/p/src/components", "/p/src"],
  );
  assert.deepEqual(listed, ["/p/src", "/p/src/components"]);
  assert.equal(hydrated[0].children[0].children[0].name, "Button.tsx");
});
