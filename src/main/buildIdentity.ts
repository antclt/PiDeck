// src/main/buildIdentity.ts
// 构建来源标记：编译期由 electron.vite.config.ts 的 define 注入（PIDECK_RELEASE_BUILD=1 时为 true）。
// 与 update/channelIdentity.ts 的「通道」正交——通道 = 跟踪哪条发布线（stable/dev）；
// 来源 = 这个二进制由谁构建（发布流水线 / 本机打包 / 源码运行）。
declare const __PIDECK_RELEASE_BUILD__: boolean;

import type { AppBuildOrigin } from "../shared/types/app";
import { app } from "electron";

/**
 * 当前二进制的构建来源（编译期标记 + 打包态，运行期不变）。
 *
 * - dev-run：未打包运行（npm run dev / E2E）。版本号仍是 package.json 的值，不参与发布比较。
 * - local-package：本机打包（pack:dev / pack / dist:* 直接跑）。版本号抄 package.json，通常与
 *   已发布版本同号，界面必须标「本地构建」，否则会被误认为官方发布版（2026-10 用户报告）。
 * - release：CI 发布流水线产出（release.yml / build-dev.yml / release-linux-manual.yml）。
 *
 * 缺省取 local 是刻意的：漏标 CI 只会让发布产物自带「本地构建」徽章（发布 smoke 一眼可见）；
 * 反过来默认 release 会让本机包冒充发布版，正是要修的困惑本身。守卫见
 * tests/releaseWorkflowBuildOrigin.test.mjs。
 */
export function resolveBuildOrigin(): AppBuildOrigin {
	if (!app.isPackaged) return "dev-run";
	return __PIDECK_RELEASE_BUILD__ ? "release" : "local-package";
}
