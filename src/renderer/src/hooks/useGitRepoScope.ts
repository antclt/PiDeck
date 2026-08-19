import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitRepoInfo } from "../../../shared/types";

function storageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:active-repo`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sameRepoPath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function readPersistedRepoPath(projectId: string): string | undefined {
  try {
    const value = localStorage.getItem(storageKey(projectId));
    return value && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

function writePersistedRepoPath(projectId: string, repoPath: string): void {
  try {
    localStorage.setItem(storageKey(projectId), repoPath);
  } catch {
    // preview / 隐私模式写不了也只影响下次打开的默认项
  }
}

function pickActiveRepo(repos: GitRepoInfo[], preferred?: string): GitRepoInfo | undefined {
  if (repos.length === 0) return undefined;
  if (preferred) {
    const matched = repos.find((repo) => sameRepoPath(repo.path, preferred));
    if (matched) return matched;
  }
  return repos.find((repo) => repo.relativePath === "") ?? repos[0];
}

export type UseGitRepoScopeInput = {
  projectId: string | undefined;
  listRepos: (projectId: string) => Promise<GitRepoInfo[]>;
};

/**
 * Git 侧栏的仓库作用域：扫描项目内独立仓库、记住上次选中项。
 * 单仓时不展示切换器，行为与改前一致（cwd = 项目根）。
 */
export function useGitRepoScope(input: UseGitRepoScopeInput) {
  const { projectId, listRepos } = input;
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [activeRepoPath, setActiveRepoPath] = useState<string | undefined>();
  const requestRef = useRef(0);

  const refreshRepos = useCallback(async () => {
    if (!projectId) {
      setRepos([]);
      setActiveRepoPath(undefined);
      return;
    }
    const request = ++requestRef.current;
    try {
      const next = await listRepos(projectId);
      if (request !== requestRef.current) return;
      setRepos(next);
      setActiveRepoPath((current) => {
        const preferred = current ?? readPersistedRepoPath(projectId);
        return pickActiveRepo(next, preferred)?.path;
      });
    } catch {
      if (request !== requestRef.current) return;
      setRepos([]);
      setActiveRepoPath(undefined);
    }
  }, [projectId, listRepos]);

  useEffect(() => {
    void refreshRepos();
  }, [refreshRepos]);

  const selectRepo = useCallback(
    (repoPath: string) => {
      if (!projectId) return;
      const next = repos.find((repo) => sameRepoPath(repo.path, repoPath));
      if (!next) return;
      setActiveRepoPath(next.path);
      writePersistedRepoPath(projectId, next.path);
    },
    [projectId, repos],
  );

  const activeRepo = useMemo(
    () => (activeRepoPath ? repos.find((repo) => sameRepoPath(repo.path, activeRepoPath)) : undefined),
    [repos, activeRepoPath],
  );

  return {
    repos,
    activeRepo,
    /**
     * 传给 git IPC 的 cwd。发现仓库后一律用选中项（含「只有一个嵌套仓」），
     * 未发现时为 undefined，主进程回退项目根以展示 init 引导。
     */
    repoPath: activeRepo?.path,
    showSwitcher: repos.length > 1,
    selectRepo,
    refreshRepos,
  };
}
