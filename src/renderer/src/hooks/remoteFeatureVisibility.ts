/**
 * 远端能力的通道门禁（纯函数，配 tests/remoteChannelGate.test.mjs）。
 *
 * 判据只有一个来源：`update:get-channel` 上报的 `devBuild`（见 useRemoteFeatureAvailable）。
 * 这里只描述「拿到这个值之后界面怎么处理」，不碰 React、不读 atom，方便对真模块做行为断言。
 */

/** 只有明确拿到 `false`（正式包）才隐藏入口；`undefined`（通道信息还没到）先照常渲染，否则 dev 通道会先闪掉入口。 */
export function isRemoteEntryVisible(available: boolean | undefined): boolean {
	return available !== false;
}

/**
 * 设置页布局按通道收口：门禁关闭时把「连接」tab 从布局里整条剔除。
 * 是剔除而不是置灰——不给入口比给了再报「未启用」更符合「正式包不提这个」。
 */
export function applyRemoteGateToSettingsLayout<T extends { id: string }>(layout: readonly T[], available: boolean | undefined): readonly T[] {
	return isRemoteEntryVisible(available) ? layout : layout.filter((entry) => entry.id !== "connections");
}
