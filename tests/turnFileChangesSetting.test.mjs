import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

const settingsType = read("src/shared/types/settings.ts");
const settingsStore = read("src/main/settings/SettingsStore.ts");
const app = read("src/renderer/src/App.tsx");
const commonTab = read("src/renderer/src/components/app/settings/CommonTab.tsx");
const atom = read("src/renderer/src/atoms/app-ui-atoms.ts");
const turnRow = read("src/renderer/src/components/session/turn/TurnRow.tsx");
const turnFileChanges = read("src/renderer/src/components/session/turn/TurnFileChanges.tsx");
const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("changed-file expansion setting is wired through settings and the turn view", () => {
  assert.match(settingsType, /expandTurnFileChanges: boolean/);
  assert.match(settingsStore, /expandTurnFileChanges: true/);
  assert.match(app, /expandTurnFileChanges: true/);
  assert.match(app, /expandTurnFileChanges: settings\.expandTurnFileChanges/);
  assert.match(commonTab, /settings\.expandTurnFileChanges/);
  assert.match(atom, /expandTurnFileChanges: boolean/);
  assert.match(turnRow, /expandByDefault=\{flowSettings\.expandTurnFileChanges\}/);
  assert.match(turnFileChanges, /defaultFileChangesPref\(props\.expandByDefault\)/);
  assert.match(zh, /"settings\.expandTurnFileChanges"/);
  assert.match(en, /"settings\.expandTurnFileChanges"/);
});
