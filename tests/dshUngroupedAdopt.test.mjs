import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  parseWorkspaceRegistry,
  accountedSessionIds,
  findWorkspaceByCwd,
  sameWorkspacePath,
} = loadTsCommonJs("src/main/dsh/dshWorkspaceRegistry.ts");
const {
  listUngroupedAdoptCandidates,
  adoptUngroupedSessions,
} = loadTsCommonJs("src/main/dsh/dshUngroupedAdopt.ts");

const WORKSPACE_JSON = JSON.stringify({
  unit: { name: "workspace", version: 2 },
  tables: {
    workspaces: {
      "ws-pi": {
        path: "D:/project/github/pi-desktop",
        title: "pi-desktop",
        sessionIds: ["session-already"],
      },
      "ws-mvp": {
        path: "D:/project/github/pi-desktop-worktrees/dsh-agent-mvp",
        title: "dsh-agent-mvp",
        sessionIds: [],
      },
    },
  },
});

test("parseWorkspaceRegistry reads official workspace.json rows", () => {
  const workspaces = parseWorkspaceRegistry(WORKSPACE_JSON);
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces[0].workspaceId, "ws-pi");
  assert.equal(workspaces[0].title, "pi-desktop");
  assert.equal(workspaces[0].sessionIds.join(","), "session-already");
  assert.equal(accountedSessionIds(workspaces).has("session-already"), true);
});

test("sameWorkspacePath / findWorkspaceByCwd ignore Windows separators and case", () => {
  assert.equal(
    sameWorkspacePath("D:\\project\\github\\pi-desktop", "D:/project/github/pi-desktop"),
    true,
  );
  const workspaces = parseWorkspaceRegistry(WORKSPACE_JSON);
  const matched = findWorkspaceByCwd(workspaces, "d:/project/github/pi-desktop");
  assert.equal(matched?.workspaceId, "ws-pi");
  assert.equal(findWorkspaceByCwd(workspaces, "C:/no-such"), undefined);
});

test("listUngroupedAdoptCandidates only adopts root sessions whose cwd already has a workspace", () => {
  const workspaces = parseWorkspaceRegistry(WORKSPACE_JSON);
  const candidates = listUngroupedAdoptCandidates([
    { id: "session-already", cwd: "D:\\project\\github\\pi-desktop" },
    { id: "session-root", cwd: "D:\\project\\github\\pi-desktop" },
    {
      id: "session-child",
      cwd: "D:\\project\\github\\pi-desktop",
      origin: "subagent",
      parentSession: "session-root",
      delegationDepth: 1,
    },
    { id: "session-appdata", cwd: "C:\\Users\\14012\\AppData\\Roaming\\orphan-dir" },
    { id: "session-mvp", cwd: "D:\\project\\github\\pi-desktop-worktrees\\dsh-agent-mvp" },
  ], workspaces);
  assert.equal(candidates.map((item) => item.dshSessionId).join(","), "session-root,session-mvp");
  assert.equal(candidates[0].workspaceId, "ws-pi");
  assert.equal(candidates[1].workspaceTitle, "dsh-agent-mvp");
});

test("adoptUngroupedSessions calls official adopt for each candidate and continues on failure", async () => {
  const adopted = [];
  const errors = [];
  const result = await adoptUngroupedSessions({
    scanHeaders: () => [
      { id: "session-root", cwd: "D:\\project\\github\\pi-desktop" },
      { id: "session-bad", cwd: "D:\\project\\github\\pi-desktop" },
    ],
    listWorkspaces: () => parseWorkspaceRegistry(WORKSPACE_JSON),
    adoptIntoWorkspace: async ({ sessionId, workspaceId }) => {
      if (sessionId === "session-bad") throw new Error("attach failed");
      adopted.push(`${workspaceId}:${sessionId}`);
    },
    onError: (id, error) => errors.push({ id, error: String(error) }),
  });
  assert.equal(result.adopted, 1);
  assert.equal(result.failed, 1);
  assert.equal(adopted.join(","), "ws-pi:session-root");
  assert.equal(errors[0].id, "session-bad");
});
