import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const host = readFileSync("src/renderer/src/components/workspace/GitDrawerHost.tsx", "utf8");
const switcher = readFileSync("src/renderer/src/components/app/git/GitRepoSwitcher.tsx", "utf8");
const scope = readFileSync("src/renderer/src/hooks/useGitRepoScope.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const i18n = [
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");

test("Git drawer hosts a repo switcher instead of stuffing logic into GitPanel", () => {
  assert.match(drawer, /<GitDrawerHost/);
  assert.doesNotMatch(drawer, /<GitPanel/);
  assert.match(host, /useGitRepoScope/);
  assert.match(host, /<GitRepoSwitcher/);
  assert.match(host, /repoPath/);
  assert.match(switcher, /t\("git\.switchRepository"\)/);
});

test("repo scope persists the last selected repository per project", () => {
  assert.match(scope, /pideck:git-panel:\$\{projectId\}:active-repo/);
  assert.match(scope, /showSwitcher: repos\.length > 1/);
  assert.match(scope, /repoPath: activeRepo\?\.path,/);
});

test("git IPC and preload accept an optional repoPath without changing init/worktree roots", () => {
  assert.match(ipc, /gitListRepos: "git:list-repos"/);
  assert.match(preload, /listRepos:/);
  assert.match(preload, /branches: \(projectId: string, repoPath\?: string\)/);
  assert.match(gitIpc, /resolveGitCwd/);
  assert.match(gitIpc, /listGitRepos\(project\.path\)/);
  assert.match(gitIpc, /await execFile\("git", \["init"\], \{ cwd: project\.path \}\)/);
  assert.match(gitIpc, /worktreeService\.list\(project\.path\)/);
});

test("diff openers carry the selected repository into the workbench", () => {
  assert.match(host, /onOpenWorkspaceFileDiff\(group, path, repoPath\)/);
  assert.match(host, /onOpenCommitFileDiff\(commit, file, repoPath\)/);
  const fileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
  assert.match(fileEditor, /workspaceFileDiff\(projectId, group, path, repoPath\)/);
  assert.match(fileEditor, /repoPath\?: string/);
});

test("repository switcher copy exists in both locales", () => {
  assert.match(i18n, /"git\.switchRepository"/);
  assert.match(i18n, /"git\.repositoryRoot"/);
});
