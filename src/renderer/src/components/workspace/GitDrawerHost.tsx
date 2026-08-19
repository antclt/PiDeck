import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BranchDiffResult,
  CommitDetail,
  CommitEntry,
  GitAheadBehind,
  GitBranchInfo,
  GitChangedFile,
  GitCommitFileDiff,
  GitGenerateCommitMessageResult,
  GitRepoInfo,
  GitResourceGroups,
  GitResourceGroupType,
  GitWorkspaceFileDiff,
} from "../../../../shared/types";
import { GitPanel } from "../app/GitPanel";
import { GitRepoSwitcher } from "../app/git/GitRepoSwitcher";
import { useGitRepoScope } from "../../hooks/useGitRepoScope";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

export type GitDrawerApi = {
  listRepos: (projectId: string) => Promise<GitRepoInfo[]>;
  commitLog: (
    projectId: string,
    options?: { maxEntries?: number; ref?: string; allBranches?: boolean },
    repoPath?: string,
  ) => Promise<CommitEntry[]>;
  commitDetail: (projectId: string, ref: string, repoPath?: string) => Promise<CommitDetail | null>;
  branchCompare: (
    projectId: string,
    base: string,
    target: string,
    repoPath?: string,
  ) => Promise<BranchDiffResult>;
  status: (projectId: string, repoPath?: string) => Promise<GitResourceGroups>;
  stage: (projectId: string, paths: string[], repoPath?: string) => Promise<void>;
  unstage: (projectId: string, paths: string[], repoPath?: string) => Promise<void>;
  discard: (
    projectId: string,
    group: "workingTree" | "untracked",
    filePath: string,
    repoPath?: string,
  ) => Promise<void>;
  commit: (projectId: string, message: string, repoPath?: string) => Promise<void>;
  cherryPick: (projectId: string, hash: string, repoPath?: string) => Promise<void>;
  revert: (projectId: string, hash: string, repoPath?: string) => Promise<void>;
  reset: (
    projectId: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
    repoPath?: string,
  ) => Promise<void>;
  dropCommit: (projectId: string, hash: string, repoPath?: string) => Promise<void>;
  generateCommitMessage: (
    projectId: string,
    repoPath?: string,
  ) => Promise<GitGenerateCommitMessageResult>;
  init: (projectId: string) => Promise<void>;
  push: (projectId: string, repoPath?: string) => Promise<void>;
  pull: (projectId: string, repoPath?: string) => Promise<void>;
  fetch: (projectId: string, repoPath?: string) => Promise<void>;
  aheadBehind: (projectId: string, repoPath?: string) => Promise<GitAheadBehind | null>;
  deleteFiles: (projectId: string, paths: string[], repoPath?: string) => Promise<void>;
  branches: (projectId: string, repoPath?: string) => Promise<GitBranchInfo>;
  checkout: (projectId: string, branch: string, repoPath?: string) => Promise<GitBranchInfo>;
  createBranch: (projectId: string, branchName: string, repoPath?: string) => Promise<GitBranchInfo>;
};

export type GitDrawerHostProps = {
  projectId: string;
  projectRoot: string | undefined;
  gitApi: GitDrawerApi;
  /** App 级项目根分支信息，单仓时继续用它，避免多打一轮 IPC */
  fallbackGitInfo: GitBranchInfo;
  fallbackSwitchBranch: (branch: string) => void;
  fallbackCreateBranch: (branchName: string) => void;
  onOpenCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
    repoPath?: string,
  ) => void | Promise<void>;
  onOpenWorkspaceFileDiff: (
    group: GitResourceGroupType,
    path: string,
    repoPath?: string,
  ) => void | Promise<void>;
  onOpenFile?: (path: string) => void;
};

const EMPTY_GIT_INFO: GitBranchInfo = { current: null, branches: [] };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Git 抽屉宿主：发现多仓时挂切换器，并把选中仓库绑到 GitPanel 的全部操作。
 * 单仓不改交互；App 的 composer 分支信息仍读项目根。
 */
export function GitDrawerHost(props: GitDrawerHostProps) {
  const {
    projectId,
    projectRoot,
    gitApi,
    fallbackGitInfo,
    fallbackSwitchBranch,
    fallbackCreateBranch,
    onOpenCommitFileDiff,
    onOpenWorkspaceFileDiff,
    onOpenFile,
  } = props;
  const scope = useGitRepoScope({
    projectId,
    listRepos: gitApi.listRepos,
  });
  const { repoPath, showSwitcher, refreshRepos } = scope;
  const [scopedGitInfo, setScopedGitInfo] = useState<GitBranchInfo>(EMPTY_GIT_INFO);

  useEffect(() => {
    if (!showSwitcher) {
      setScopedGitInfo(EMPTY_GIT_INFO);
      return;
    }
    let cancelled = false;
    void gitApi
      .branches(projectId, repoPath)
      .then((next) => {
        if (!cancelled) setScopedGitInfo(next);
      })
      .catch(() => {
        if (!cancelled) setScopedGitInfo(EMPTY_GIT_INFO);
      });
    return () => {
      cancelled = true;
    };
  }, [gitApi, projectId, repoPath, showSwitcher]);

  const gitInfo = showSwitcher ? scopedGitInfo : fallbackGitInfo;

  const handleSwitchBranch = useCallback(
    (branch: string) => {
      if (!showSwitcher) {
        fallbackSwitchBranch(branch);
        return;
      }
      void gitApi
        .checkout(projectId, branch, repoPath)
        .then((next) => setScopedGitInfo(next))
        .catch((error: unknown) => {
          showNotice(t("app.branchSwitchFailed", { error: errorText(error) }), 4000, "error");
          void gitApi.branches(projectId, repoPath).then(setScopedGitInfo).catch(() => undefined);
        });
    },
    [fallbackSwitchBranch, gitApi, projectId, repoPath, showSwitcher],
  );

  const handleCreateBranch = useCallback(
    (branchName: string) => {
      if (!showSwitcher) {
        fallbackCreateBranch(branchName);
        return;
      }
      void gitApi
        .createBranch(projectId, branchName, repoPath)
        .then((next) => {
          setScopedGitInfo(next);
          showNotice(t("app.branchCreated", { branch: branchName }), 2500);
        })
        .catch((error: unknown) => {
          showNotice(t("app.branchCreateFailed", { error: errorText(error) }), 4000, "error");
        });
    },
    [fallbackCreateBranch, gitApi, projectId, repoPath, showSwitcher],
  );

  const scopedApi = useMemo(
    () => ({
      commitLog: (id: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) =>
        gitApi.commitLog(id, options, repoPath),
      commitDetail: (id: string, ref: string) => gitApi.commitDetail(id, ref, repoPath),
      branchCompare: (id: string, base: string, target: string) =>
        gitApi.branchCompare(id, base, target, repoPath),
      getStatus: (id: string) => gitApi.status(id, repoPath),
      stageFiles: (id: string, paths: string[]) => gitApi.stage(id, paths, repoPath),
      unstageFiles: (id: string, paths: string[]) => gitApi.unstage(id, paths, repoPath),
      discardFile: (id: string, group: "workingTree" | "untracked", path: string) =>
        gitApi.discard(id, group, path, repoPath),
      commit: (id: string, message: string) => gitApi.commit(id, message, repoPath),
      cherryPick: (id: string, hash: string) => gitApi.cherryPick(id, hash, repoPath),
      revert: (id: string, hash: string) => gitApi.revert(id, hash, repoPath),
      reset: (id: string, hash: string, mode: "soft" | "mixed" | "hard") =>
        gitApi.reset(id, hash, mode, repoPath),
      dropCommit: (id: string, hash: string) => gitApi.dropCommit(id, hash, repoPath),
      generateCommitMessage: (id: string) => gitApi.generateCommitMessage(id, repoPath),
      gitInit: async (id: string) => {
        await gitApi.init(id);
        await refreshRepos();
      },
      push: (id: string) => gitApi.push(id, repoPath),
      pull: (id: string) => gitApi.pull(id, repoPath),
      fetch: (id: string) => gitApi.fetch(id, repoPath),
      aheadBehind: (id: string) => gitApi.aheadBehind(id, repoPath),
      deleteFiles: (id: string, paths: string[]) => gitApi.deleteFiles(id, paths, repoPath),
    }),
    [gitApi, refreshRepos, repoPath],
  );

  const handleOpenWorkspaceFileDiff = useCallback(
    (group: GitResourceGroupType, path: string) => onOpenWorkspaceFileDiff(group, path, repoPath),
    [onOpenWorkspaceFileDiff, repoPath],
  );

  const handleOpenCommitFileDiff = useCallback(
    (commit: CommitEntry, file: GitChangedFile) => onOpenCommitFileDiff(commit, file, repoPath),
    [onOpenCommitFileDiff, repoPath],
  );

  return (
    // 切换器与 GitPanel 是同一个抽屉表面；在宿主层挂上 git-panel，
    // 让它也继承 --git-panel-* token，避免切换仓库后顶部出现另一块底色。
    <div className="git-panel flex h-full min-h-0 flex-col overflow-hidden">
      {showSwitcher ? (
        <GitRepoSwitcher
          repos={scope.repos}
          activePath={scope.activeRepo?.path}
          onSelect={scope.selectRepo}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <GitPanel
          projectId={projectId}
          projectRoot={scope.activeRepo?.path ?? projectRoot}
          repoScopeKey={scope.activeRepo?.path ?? projectRoot}
          commitLog={scopedApi.commitLog}
          commitDetail={scopedApi.commitDetail}
          onOpenCommitFileDiff={handleOpenCommitFileDiff}
          onOpenWorkspaceFileDiff={handleOpenWorkspaceFileDiff}
          onOpenFile={onOpenFile}
          branchCompare={scopedApi.branchCompare}
          getStatus={scopedApi.getStatus}
          stageFiles={scopedApi.stageFiles}
          unstageFiles={scopedApi.unstageFiles}
          discardFile={scopedApi.discardFile}
          commit={scopedApi.commit}
          branches={gitInfo.branches}
          currentBranch={gitInfo.current}
          onSwitchBranch={handleSwitchBranch}
          onCreateBranch={handleCreateBranch}
          cherryPick={scopedApi.cherryPick}
          revert={scopedApi.revert}
          reset={scopedApi.reset}
          dropCommit={scopedApi.dropCommit}
          generateCommitMessage={scopedApi.generateCommitMessage}
          gitInit={scopedApi.gitInit}
          push={scopedApi.push}
          pull={scopedApi.pull}
          fetch={scopedApi.fetch}
          aheadBehind={scopedApi.aheadBehind}
          deleteFiles={scopedApi.deleteFiles}
        />
      </div>
    </div>
  );
}
