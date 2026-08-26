import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  countSelectedModelIndexes,
  getModelSelectionState,
  removeSelectedModelIndexes,
  toggleAllModelIndexes,
  toggleModelIndex,
} = loadTsCommonJs("src/renderer/src/config/modelBatchSelection.ts");

test("model selection toggles one row without mutating the original set", () => {
  const original = new Set([1]);
  const next = toggleModelIndex(original, 2);

  assert.deepEqual([...original], [1]);
  assert.deepEqual([...next], [1, 2]);
  assert.deepEqual([...toggleModelIndex(next, 1)], [2]);
});

test("model selection exposes checked, indeterminate, and unchecked states", () => {
  assert.equal(getModelSelectionState(new Set(), 3), "unchecked");
  assert.equal(getModelSelectionState(new Set([1]), 3), "indeterminate");
  assert.equal(getModelSelectionState(new Set([0, 1, 2]), 3), "checked");
  assert.equal(countSelectedModelIndexes(new Set([0, 4]), 3), 1);
});

test("select-all toggles the current model rows and ignores stale indexes", () => {
  assert.deepEqual([...toggleAllModelIndexes(new Set(), 3)], [0, 1, 2]);
  assert.deepEqual([...toggleAllModelIndexes(new Set([0, 1, 2, 99]), 3)], []);
  assert.deepEqual([...toggleAllModelIndexes(new Set([0]), 3)], [0, 1, 2]);
});

test("batch deletion removes exactly the selected model rows", () => {
  const models = ["alpha", "beta", "gamma", "delta"];
  assert.deepEqual(removeSelectedModelIndexes(models, new Set([1, 3])), ["alpha", "gamma"]);
  assert.deepEqual(models, ["alpha", "beta", "gamma", "delta"]);
});
