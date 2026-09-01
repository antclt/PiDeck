import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { atom, createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    Map,
  }, { filename: filePath });
  return module.exports;
}

function loadOutlineAtoms(buildOutline) {
  const currentSessionIdAtom = atom(undefined);
  const sessionMessagesCacheAtom = atom({});
  const projectionCache = compileModule("src/renderer/src/atoms/outlineProjectionCache.ts");
  const outlineAtoms = compileModule("src/renderer/src/atoms/session-outline-atoms.ts", {
    "./session-atoms": { currentSessionIdAtom, sessionMessagesCacheAtom },
    "./outlineProjectionCache": projectionCache,
    "../components/app/AppUtils": {
      buildOutline,
      getToolChangedLineCount: () => 0,
      getToolFilePath: () => undefined,
      getToolNewContent: () => undefined,
    },
  });
  return { ...outlineAtoms, currentSessionIdAtom, sessionMessagesCacheAtom, projectionCache };
}

function message(id, role, text, timestamp) {
  return { id, agentId: "agent", role, text, timestamp };
}
function entry(messages, outlineRevision) {
  return {
    messages,
    revision: outlineRevision,
    source: "runtime",
    updatedAt: 1,
    outlineRevision,
    outlineLastUserIndex: 0,
  };
}

test("unchanged outline revision returns the existing outline projection", () => {
  let buildCount = 0;
  const atoms = loadOutlineAtoms((messages) => {
    buildCount += 1;
    return messages.filter((message) => message.role === "user").map((message) => ({
      id: message.id,
      role: message.role,
      title: message.text,
      time: String(message.timestamp),
    }));
  });
  const store = createStore();
  store.set(atoms.currentSessionIdAtom, "session-a");
  store.set(atoms.sessionMessagesCacheAtom, {
    "session-a": entry([
      message("question", "user", "Question", 1),
      message("answer", "assistant", "Partial", 2),
    ], 7),
  });
  const first = store.get(atoms.outlineItemsAtom);

  store.set(atoms.sessionMessagesCacheAtom, {
    "session-a": entry([
      message("question", "user", "Question", 1),
      message("answer", "assistant", "Completed", 2),
    ], 7),
  });
  const second = store.get(atoms.outlineItemsAtom);

  assert.equal(second, first);
  assert.equal(buildCount, 1);
});

test("advanced outline revision rebuilds the user checkpoint projection", () => {
  const atoms = loadOutlineAtoms((messages) =>
    messages.filter((message) => message.role === "user").map((message) => ({
      id: message.id,
      role: message.role,
      title: message.text,
      time: String(message.timestamp),
    }))
  );
  const store = createStore();
  store.set(atoms.currentSessionIdAtom, "session-a");
  store.set(atoms.sessionMessagesCacheAtom, {
    "session-a": entry([message("question", "user", "Original", 1)], 7),
  });
  const first = store.get(atoms.outlineItemsAtom);

  store.set(atoms.sessionMessagesCacheAtom, {
    "session-a": entry([message("question", "user", "Edited", 1)], 8),
  });
  const second = store.get(atoms.outlineItemsAtom);

  assert.notEqual(second, first);
  assert.equal(second[0].title, "Edited");
});