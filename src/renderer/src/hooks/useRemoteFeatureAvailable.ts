import { useAtomValue } from "jotai";
import { updateChannelInfoAtom } from "../atoms/channelSwitchAtoms";

/**
 * 远端开发入口是否可用（通道门禁）：`false` = 当前构建不提供远端能力，界面不渲染任何入口。
 *
 * 判据与主进程 `remoteExperimentEnabled`（main/index.ts → update/channelIdentity 的
 * `isDevChannelBuild()`）同源：未打包运行（npm run dev / E2E）与 dev 通道安装包为 true，
 * stable 通道安装包为 false。数据来自 App 启动时那次 `update:get-channel`
 *（updateChannelInfoAtom 的 devBuild），因此不新增 IPC、也不另发请求。
 *
 * 未拿到通道信息时返回 `undefined`：调用方按「先照常渲染」处理，等真实值到达后收口。
 * 若一开始就按不可用处理，dev 通道会先闪掉入口再出现。
 */
export function useRemoteFeatureAvailable(): boolean | undefined {
	return useAtomValue(updateChannelInfoAtom)?.devBuild;
}
