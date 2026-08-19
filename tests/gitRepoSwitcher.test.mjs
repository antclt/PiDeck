import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const host = readFileSync("src/renderer/src/components/workspace/GitDrawerHost.tsx", "utf8");
const scope = readFileSync("src/renderer/src/hooks/useGitRepoScope.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const graph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");

// 文件名保留，确保从旧切换器实现迁移时仍会运行这组多仓契约测试。
test("Git drawer renders every discovered repository instead of selecting one active repository", () => {
  assert.match(drawer, /<GitDrawerHost/);
  assert.doesNotMatch(drawer, /<GitPanel/);
  assert.match(host, /useGitRepoScope/);
  assert.match(host, /scope\.repos\.map\(\(repo\)/);
  assert.match(host, /repositoryLabel=\{repositoryLabel\}/);
  assert.doesNotMatch(host, /GitRepoSwitcher/);
  assert.doesNotMatch(host, /activeRepo/);
});

test("repo discovery no longer persists or exposes a selected repository", () => {
  assert.match(scope, /hasMultipleRepos: repos\.length > 1/);
  assert.doesNotMatch(scope, /active-repo/);
  assert.doesNotMatch(scope, /selectRepo/);
  assert.doesNotMatch(scope, /localStorage/);
});

test("each repository panel keeps its Git operations and branch state bound to its own path", () => {
  assert.match(host, /function createScopedGitApi/);
  assert.match(host, /gitApi\.status\(id, repoPath\)/);
  assert.match(host, /gitInfoByRepoPath/);
  assert.match(host, /gitApi\s*\.checkout\(projectId, branch, repoPath\)/);
  assert.match(host, /repoScopeKey=\{repoPath \?\? projectRoot\}/);
  assert.match(host, /onOpenWorkspaceFileDiff\(group, path, repoPath\)/);
  assert.match(host, /onOpenCommitFileDiff\(commit, file, repoPath\)/);
});

test("multi-repository panes have isolated persisted state and unique pane ids", () => {
  assert.match(panel, /encodeURIComponent\(repoScopeKey\).*pane-state:v4/);
  assert.match(panel, /const paneIdPrefix = useId\(\)/);
  assert.match(panel, /id=\{`git-pane-\$\{paneIdPrefix\}-changes`\}/);
  assert.match(panel, /paneIdPrefix=\{paneIdPrefix\}/);
  assert.match(graph, /paneIdPrefix: string/);
  assert.match(graph, /id=\{`git-pane-\$\{props\.paneIdPrefix\}-graph`\}/);
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
