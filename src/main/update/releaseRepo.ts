import { GITHUB_REPO_OWNER, UPDATE_REPO } from "../../shared/updateSources";

/**
 * PiDeck 更新所指向的 GitHub 仓库坐标。
 *
 * 坐标唯一事实来源已收敛到 shared/updateSources.ts（GitHub 与 AtomGit 两侧拆分：
 * 仓库已转到组织 `pideck-app`，而 AtomGit 镜像仍是个人账号）——这里直接复用，
 * 不再手抄字面量，避免两处坐标漂移。
 *
 * electron-updater 的 GitHub provider 从 package.json build.publish 读取仓库坐标
 * （无需在此注入）；此常量仅用于非更新链路的 Release 资产 URL（如 DSH runtime 索引）。
 */
export const UPDATE_REPO_OWNER = GITHUB_REPO_OWNER;
export { UPDATE_REPO };

export const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
