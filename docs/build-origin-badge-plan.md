# 构建来源标记（本地构建 ≠ 发布版）方案

> 状态：**已实施（2026-10-27）**。决策：A 方案（默认 local，CI 显式标 release）、徽章文案「本地构建」、范围只改「设置 → 开发设置」（关于弹框不做）。落地清单与验证结果见 §12。
> 触发：`npm run pack:dev` 产物在「设置 → 开发设置」显示 `PiDeck v0.9.7 · Stable · 已是最新版本`，
> 用户无法从界面判断这是本机打包的 dev 代码，还是官方 0.9.7 发布版（版本号相同）。
> 本文只解决「构建来源可见」，不改通道语义、不改版本号。

## 0. 结论形状（推荐）

新增一个与通道**正交**的编译期标记，主进程算出三态 `buildOrigin`，渲染层只做展示：

```
__PIDECK_RELEASE_BUILD__ = process.env.PIDECK_RELEASE_BUILD === "1"   // 编译期 define

resolveBuildOrigin(): "dev-run" | "local-package" | "release"
  !app.isPackaged                     → "dev-run"        （npm run dev / E2E）
  packaged && !__PIDECK_RELEASE_BUILD__ → "local-package" （pack:dev / pack / dist:* 本机打包）
  packaged &&  __PIDECK_RELEASE_BUILD__ → "release"       （CI 发布流水线产物）
```

- UI：`local-package` 显示「本地构建」徽章 + 一行说明；`dev-run` 显示「开发运行」；`release` 不显示（现状）。
- 默认值取 **local**（只有 CI 显式 opt-in 才是 release）——漏标时发布产物会自己露出「本地构建」，可在 smoke 抓到；
  反过来默认 release 会让本机包冒充发布版，正是今天这个问题。
- 不动 `app.getVersion()`：版本号参与 electron-updater 比较、`latest*.yml`、artifact 名、userData 目录与单实例锁，
  加后缀等于污染升级链路（见 §9）。

## 1. 现状证据（为什么「Stable」不是 bug，但缺一块信息）

| 事实 | 位置 |
|---|---|
| 徽章取 `props.channel`，非 dev 即 Stable | `src/renderer/src/components/app/settings/AppUpdateCard.tsx:99` |
| channel 来自 `update:get-channel` | `src/main/ipc/systemIpc.ts:1321-1326` |
| 通道编译期固定：`__PIDECK_DEV_BUILD__ ? "dev" : "stable"` | `src/main/update/channelIdentity.ts:10-12` |
| define 来源 `PIDECK_DEV_BUILD === "1"` | `electron.vite.config.ts:135` |
| `pack:dev` 不注入该 env（只改输出目录） | `scripts/pack-dev.js:31,33-34` |
| 只有 `dist:*:dev` 注入 `PIDECK_DEV_BUILD: "1"` | `scripts/dist-dev.js:77` |
| 守卫：`pack:dev` 必须属于 stable 系脚本 | `tests/distDevScripts.test.mjs:22-27` |
| 「已是最新」= `lastCheckAt` 且 `!hasUpdate` | `AppUpdateCard.tsx:241` |

即：界面只有「跟踪哪条发布线」一个维度，没有「这个二进制是谁构建的」维度。本地打包的 stable 通道包与官方发布包在 UI 上完全同形。

## 2. 术语裁决（写进文案与注释，避免再次混淆）

- **通道（channel, stable/dev）**：跟踪哪条发布线、是否吃 prerelease、下载源。编译期固定，运行期不变。
- **构建来源（buildOrigin, release/local-package/dev-run）**：这个二进制出自发布流水线、本机打包，还是源码运行。与通道正交。
- 现有 `devBuild`（`UpdateChannelInfo.devBuild`，`src/shared/types/app.ts:370`）= `未打包 || dev 通道包`，语义保持不变，不拿它当来源用。

## 3. 方案对比

| | A：默认 local，CI 显式标 release（推荐） | B：默认 release，本地脚本标 local |
|---|---|---|
| 入口数 | 发布入口只有 3 个 workflow 的 build 步骤 | 本地入口 8+（pack / pack:dev / dist / dist:win / dist:mac / dist:linux / dist:fast / dist:*:dev）+ 裸 `npx electron-builder` |
| 漏标后果 | 发布版显示「本地构建」→ 肉眼可见、发布 smoke 必发现 | 本机包冒充发布版 → 静默，正是今天的问题 |
| 需改 CI | 是（3 处 env） | 否 |
| 守卫测试 | 「发布 workflow 必须设 PIDECK_RELEASE_BUILD」可穷举 | 只能逐个脚本抽查，易漏 |
| 结论 | **采用** | 否决 |

（另有两种备选被否决：① 打包时读 `git describe` 自动判定——浅克隆/无 git/预发布 tag 语义都会误判；
② 打包时经 `extraMetadata` 写 package.json 字段再运行期读 asar——需要运行期读文件，且同样属 B 的漏标方向。）

## 4. 代码改动清单（A 方案）

契约层：
- `src/shared/types/app.ts`：新增 `export type AppBuildOrigin = "release" | "local-package" | "dev-run"`；
  `UpdateChannelInfo` 增加必填 `buildOrigin: AppBuildOrigin`（注释写清与 `channel`/`devBuild` 的区别）。
- `src/shared/ipc.ts`：**不改**（无新通道）。

主进程：
- `electron.vite.config.ts:133-136` define 块加 `__PIDECK_RELEASE_BUILD__: JSON.stringify(process.env.PIDECK_RELEASE_BUILD === "1")`（与现有写法并列，注明用途）。
- 新增 `src/main/buildIdentity.ts`：`declare const __PIDECK_RELEASE_BUILD__` + `resolveBuildOrigin()`（上文三态），注释交叉引用 `channelIdentity.ts`（通道）与 `deepLinkScheme.ts`（同类 declare 写法）。
- `src/main/ipc/systemIpc.ts:1321-1326`：payload 增加 `buildOrigin: resolveBuildOrigin()`。
- `src/main/index.ts:127` 附近：启动日志记一次 `{ channel, buildOrigin, isPackaged }`（支持排障时一眼看出包来自哪里）。

渲染层：
- `AppUpdateCard.tsx`：新增 prop `buildOrigin`；版本行在通道徽章左侧/右侧再挂一个来源徽章（`local-package` 灰/琥珀、`dev-run` 蓝），来源徽章只在非 `release` 时渲染；
  版本行下方加一行 caption（仅非 release）：本地构建 → 「本机构建：版本号取自 package.json，“已是最新”只表示版本字符串与最新发布版相同。」
- `DevTab.tsx:415-416`：把 `updateChannelInfoAtom` 里的 `buildOrigin` 透传给卡片（与 `channel` 同源，不新增 IPC）。
- `AboutPopover.tsx:57`：版本号后加同款小徽章（与卡片复用同一 i18n key），让「关于」也能自证来源。
- `src/renderer/src/previewApi.ts:1255`：stub 补 `buildOrigin: "release"`（浏览器预览不显示来源徽章；字段必填，typecheck 会强制同步这里）。

## 5. CI 改动（3 处 env，缺一即回退成「本地构建」）

| 文件 | 位置 | 改动 |
|---|---|---|
| `.github/workflows/release.yml` | `Build packages` 步骤 env（:283-291） | 加 `PIDECK_RELEASE_BUILD: "1"`（一个 job 覆盖 5 个 matrix 条目，含 `command_dev`） |
| `.github/workflows/build-dev.yml` | `Build dev packages` 步骤 env（:129-133） | 加 `PIDECK_RELEASE_BUILD: "1"`（dev 通道正式产物） |
| `.github/workflows/release-linux-manual.yml` | `Build Linux … packages` 步骤 env（:83-89） | 加 `PIDECK_RELEASE_BUILD: "1"`（产物追加到已发布 Release） |

不改：`build-windows.yml` / `build-linux.yml` / `build-macos.yml` / `mac-test-build.yml`（只上传 workflow artifact，不发 Release）
→ 产物显示「本地构建」是**准确**的。判据由守卫测试按「workflow 里出现 `softprops/action-gh-release` ⇒ 必须设该 env」表达，不写死文件名。

## 6. 文案与 i18n

新增 key（`src/renderer/src/i18n/rendererCopy.zh-CN.ts` + `rendererCopy.en-US.ts`，两处手改）：
- `settings.buildOriginLocal` = 本地构建 / Local build
- `settings.buildOriginDevRun` = 开发运行 / Dev run
- `settings.buildOriginLocalHint` = 本机构建：版本号取自 package.json，“已是最新”只表示版本字符串与最新发布版相同。 / Local build: version comes from package.json; “up to date” only compares version strings.

流程（铁律 9）：改完 zh-CN 后 `npm i --no-save opencc-js@1.4.2 && node scripts/genZhTwCopy.mjs`，四份 `*.zh-TW.ts` 只由脚本生成，禁止手改；收尾用 `node scripts/genZhTwCopy.mjs --check` 复核。

## 7. 测试与门禁

新增（不改既有断言）：
1. `tests/buildOrigin.test.mjs`：用现有沙箱写法覆盖三态（`electron` 必须走 `stubs`——裸 `nodeRequire("electron")` 拿到的是二进制路径字符串，`app` 为 undefined）：
   - `createTsSandbox({ stubs: { electron: { app: { isPackaged: false } } }, globals: { __PIDECK_RELEASE_BUILD__: false } })` → `dev-run`
   - `{ isPackaged: true }` + `false` → `local-package`
   - `{ isPackaged: true }` + `true` → `release`
2. `tests/releaseWorkflowBuildOrigin.test.mjs`：扫 `.github/workflows/*.yml`，凡含 `softprops/action-gh-release` 且执行 `npm run build`/`dist-*` 的 workflow，其构建步骤 env 必须出现 `PIDECK_RELEASE_BUILD: "1"`；反向：`pack:dev` / `dist-dev.js` 源码里不得出现该变量（本地永不自我标 release）。
3. helpers 增补：`tests/helpers/createTsSandbox.mjs:124` 与 `tests/helpers/loadTsCommonJs.mjs:96` 并列补 `__PIDECK_RELEASE_BUILD__: false` 默认值（与 `__PIDECK_DEV_BUILD__` 同因：不预置则任何 import 到 `buildIdentity` 的沙箱整片 ReferenceError）。这是**增量**，不改任何既有断言。

必跑：
- `npm run typecheck`
- `node --test tests/buildOrigin.test.mjs tests/releaseWorkflowBuildOrigin.test.mjs tests/channelIdentity.test.mjs tests/distDevScripts.test.mjs tests/tsSandboxHelper.test.mjs`
- `node scripts/genZhTwCopy.mjs --check`
- `npm run check:ipc-wiring`（payload 加字段不改通道，预期本就绿；跑一次确认）

手工验证矩阵：

| 命令 | 预期「设置 → 开发设置」 |
|---|---|
| `npm run dev` | 来源徽章「开发运行」，无「已是最新」提示矛盾 |
| `npm run pack:dev` → release-dev/win-unpacked | 来源徽章「本地构建」+ 版本行下方说明 |
| `PIDECK_RELEASE_BUILD=1 npm run pack:dev` | 不显示来源徽章（等价发布产物的形态） |
| `npm run dist:win:dev`（本机） | 通道「Dev」（琥珀）+ 来源「本地构建」 |
| CI `release.yml` 产物 | 只有通道徽章 |

## 8. 实施顺序（4 个可独立 review 的提交）

1. 契约 + define + `buildIdentity.ts` + `systemIpc` payload + 启动日志 + `previewApi` stub（此时 UI 未消费，行为零变化；typecheck 绿）。
2. 渲染层三处 UI + zh-CN/en-US 文案 + 重新生成 zh-TW。
3. 三个 workflow env 注入 + 两个新测试 + helpers 默认值。
4. 文档：`docs/release-process.md` 打包段落加一条「发布产物必须由设置 `PIDECK_RELEASE_BUILD=1` 的 CI 步骤构建」；`docs/maintenance-domains.md` 品牌/构建身份段加一条（注入点、三态含义、守卫测试名）；本文状态改「已实施」。

工作量估计：改动约 10 个文件（其中 2 个 workflow、2 个文案、5 个源码、1 个测试新增），净增约 +120/-10 行；实现 1–1.5 h，验证与手工矩阵 0.5–1 h。

## 9. 明确不做 / 风险

不做：
- 不改 `app.getVersion()`、不给版本号加 `-local` 后缀（会污染 updater 比较、`latest*.yml`、artifact 名、userData 目录与单实例锁）。
- 不改通道语义、不让本地构建自动切 dev 通道、不关掉本地构建的更新检查。
- 不用运行期环境变量判定来源（发布包里环境不同、且可伪造）。
- 不新增 IPC 通道（只扩既有 payload，unified-api 的通道/前缀/命名空间快照不变）。

风险：
- CI 漏标 → 发布产物显示「本地构建」。由 §7 守卫测试 + 发布前 smoke 双保险。
- 「来源」与「通道」两个徽章并排可能被误读为同一维度：靠中性色 vs 语义色 + 版本行下方说明句区分（§2 术语写进注释，不额外做悬浮提示）。
- 主/渲染同包发布，字段必填无需兼容旧主进程；preview 走 stub，保持 release 以免预览页出现假徽章。

## 10. 决策（已定 2026-10-27）

1. **默认方向**：A —— 默认 local（`__PIDECK_RELEASE_BUILD__` 缺省 false），发布 workflow 显式注入 `PIDECK_RELEASE_BUILD=1`。
2. **文案**：「本地构建」；未打包运行不另起文案（同样显示「本地构建」，由版本行说明句覆盖语义）。
3. **范围**：只改「设置 → 开发设置」卡片；「关于」弹框不做。

## 11. 验收标准

- `npm run pack:dev` 产物的开发设置卡片能一眼读出「本机打包、非发布版」，且「已是最新」旁有解释性文案；
- CI 发布产物（模拟 `PIDECK_RELEASE_BUILD=1`）UI 与今天完全一致（零视觉变化）；
- §7 全部门禁绿；未提交改动只包含 §12 列出的文件。

## 12. 实施记录（2026-10-27）

决策：A 方案（默认 local，发布 workflow 显式标 release）· 徽章文案「本地构建」· 范围只到「设置 → 开发设置」。

改动文件：

| 文件 | 改动 |
|---|---|
| `src/shared/types/app.ts` | 新增 `AppBuildOrigin`；`UpdateChannelInfo.buildOrigin` 必填 |
| `electron.vite.config.ts` | define `__PIDECK_RELEASE_BUILD__`（`PIDECK_RELEASE_BUILD === "1"`） |
| `src/main/buildIdentity.ts` | 新增：`resolveBuildOrigin()` 三态判定 |
| `src/main/ipc/systemIpc.ts` | `update:get-channel` payload 增 `buildOrigin` |
| `src/main/index.ts` | 启动日志记一次 `{ channel, buildOrigin, packaged }` |
| `src/renderer/src/components/app/settings/AppUpdateCard.tsx` | 非 release 时加「本地构建」徽章 + 版本行下方说明句 |
| `src/renderer/src/components/app/settings/DevTab.tsx` | 从 `updateChannelInfoAtom` 透传 `buildOrigin`（初拉前按 release 兜底，避免闪烁） |
| `src/renderer/src/previewApi.ts` | 预览 stub 补 `buildOrigin: "release"` |
| `src/renderer/src/i18n/rendererCopy.zh-CN.ts` / `.en-US.ts` | 新增 `settings.buildOriginLocal` / `settings.buildOriginLocalHint` |
| `src/renderer/src/i18n/rendererCopy.zh-TW.ts` | 由 `node scripts/genZhTwCopy.mjs` 生成（含 source-sha256 刷新） |
| `.github/workflows/release.yml` / `build-dev.yml` / `release-linux-manual.yml` | 构建步骤 env 注入 `PIDECK_RELEASE_BUILD: "1"` |
| `tests/buildOrigin.test.mjs` | 新增：三态判定（`createTsSandbox` + electron stub） |
| `tests/releaseWorkflowBuildOrigin.test.mjs` | 新增：发布 workflow 必须有标记 / 本地脚本不得有标记 |
| `tests/helpers/createTsSandbox.mjs` / `loadTsCommonJs.mjs` | 沙箱默认 `__PIDECK_RELEASE_BUILD__: false`（增量） |
| `docs/release-process.md` / `docs/maintenance-domains.md` | 记录注入规则与缺省方向 |

验证结果（本机 2026-10-27）：

- `npm run typecheck` → 通过；
- `node --test tests/buildOrigin.test.mjs tests/releaseWorkflowBuildOrigin.test.mjs tests/channelIdentity.test.mjs tests/distDevScripts.test.mjs tests/tsSandboxHelper.test.mjs tests/zhTwCopy.test.mjs` → 30/30 通过；
- 关联回归：`mainProcessI18n / overlayLeafContracts / streamdownRenderer / uiProgress / channelSwitchService / unifiedApiChannelSnapshot / unifiedApiDomainCatalog / releaseSelectionSharedBoundary / piUpdateStartupNotice / archMismatchNotice / appTypeHygiene` → 84/84 通过；
- `node scripts/genZhTwCopy.mjs --check` → 4 份 zh-TW 与 zh-CN 同步；
- `npm run check:ipc-wiring` → 769 通道齐备（未新增通道）；
- `node scripts/check-test-shape.mjs` → 新增 sourceOnly 测试 0（两个新测试都跑真模块/配置判据）；
- `npm run check:format` → 无改动；
- `npx electron-vite build` → 通过；产物核对：`out/main/index.js` 的 `resolveBuildOrigin` 已内联为 `return "local-package"`（本机 dev 构建），渲染层 i18n chunk 含 `"settings.buildOriginLocal": "本地构建"`。

未做（用户明确缩小范围）：「关于」弹框不显示构建来源徽章；不新增 `dev-run` 独立文案（未打包运行同样显示「本地构建」，语义由说明句覆盖）。
