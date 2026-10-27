import { atom } from "jotai";
import type { RemoteHostIdentityIndex } from "../utils/remoteHostIdentity";

/**
 * 远端主机身份 + 连接状态的渲染层快照（侧栏项目行读取）。
 *
 * 为什么进 atom：项目行会随折叠/切 Tab 反复挂载，主机目录也不应该每挂一次就重新查一遍 IPC。
 * 权威仍有两处（主进程的 host store 与连接管理器）；这里只存「最近一次列表 + 最近一次推送」。
 */
export const remoteHostIdentityIndexAtom = atom<RemoteHostIdentityIndex>({});
