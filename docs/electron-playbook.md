# Electron 实战手册

> 改 `main/index.ts`、窗口创建、preload、webview、打包配置、原生模块或跨平台路径前读本文。每条都是踩坑结论。

## 启动与生命周期

- `commandLine.appendSwitch` / `app.setPath` / 单实例判断必须在 `app.whenReady()` 前。
- **userData 三分支**（`portableUserData.resolveAppUserDataDir`，有单测；不要按旧文档「dev 加 -dev 后缀」理解；完整路径与迁移细节见 `docs/maintenance-domains.md` §应用命名与历史数据目录迁移）：
  - 未打包 `npm run dev`：按 git 分支隔离到 `PiDeck-dev[-branch]`，避免多 worktree 共用 catalog / 单实例锁 / DSH home。
  - 打包态（stable 与 dev 通道安装包）：**共用** `%APPDATA%/PiDeck`——用户在两个通道间切换不丢 settings / 会话 / 扩展配置，这是刻意决策。
  - 便携 exe：落 `PORTABLE_EXECUTABLE_DIR/data`，与安装版隔离。
- 启动前还有一次性目录改名迁移（历史 `pi-desktop` → `PiDeck`，含 pi 会话 encoded 目录）；失败自动回退旧目录、下次重试。
- 关键节点（窗口创建、load、preload、pi 启动）必须写 `appLogger`；冷启动有里程碑计时（`bootAnchorMs`），改动启动链后看日志对比回归。
- 单实例用自研按版本互斥 `acquireVersionSingleInstance`（见 `instanceLockFile.ts`），**不用** `requestSingleInstanceLock`（原生锁会阻止不同版本并行）；第二实例 `app.exit(0)`。dev 与 stable 使用不同 AUMID，避免通知归属混淆。
- 窗口隐藏时先 `maximize()` 再加载，避免布局跳变；`zoomFactor` 在 `did-finish-load` 后应用。
- quit 路径覆盖 pi 子进程、node-pty、watcher、锁文件；新增常驻资源必须同步登记 `QuitCleanupRegistry`（`registerQuitCleanup`）。

## 窗口与 webview

- 主窗口基线：`contextIsolation: true` + `nodeIntegration: false` + `webviewTag: true`（仅主窗口）。其它窗口（浮动窗、选择浮窗、插件视图）必须 `webviewTag: false`，新增窗口逐项评估，禁止默认全开。
- Chromium 沙箱默认关闭是刻意的（Windows 安全软件/旧驱动在沙箱初始化触发 `0x80000003`）；关闭时显式 `appendSwitch("no-sandbox")`。开关改动需整应用重启。
- `setWindowOpenHandler` 主窗口与 webview guest 都要注册：走 `openExternalUrl` 并 deny；浮动窗/插件视图/选择浮窗一律 `deny`。
- webview 安全（`configureBrowserPanelWebviewHost`，只在主窗口注册一次）：专属 `partition` 强制 `sandbox: true` / `nodeIntegration: false` / `webSecurity: true`；删除外部传入的 `preload` / `allowpopups`；`did-attach-webview` 校验 partition，不符立即 close。
- 导航白名单三层都要过：`will-frame-navigate` / `will-redirect` / `setWindowOpenHandler`（只拦一层会被重定向绕过）。内置浏览器的 URL 判定统一走 `isAllowedBrowserPanelUrl`（`src/main/browser/browserSecurity.ts`）。
- 自定义标题栏改动要验证三平台控制按钮、拖拽区、双击最大化。

## E2E 测试窗口（不打扰模式）

- `PIDECK_E2E=1` 时主窗口默认摆到屏幕外（`src/main/e2eWindowMode.ts`）：`setPosition(-32000,-32000)` + `setSkipTaskbar(true)` + `showInactive`。
- 同时关闭后台节流：`backgroundThrottling: false` + `disable-background-timer-throttling` / `disable-renderer-backgrounding` / `disable-backgrounding-occluded-windows` + `disable-features=CalculateNativeWinOcclusion`。否则 Windows 遮挡判定会把屏幕外窗口当不可见，Playwright 点击/截图随机卡死。
- **跑 e2e 不得把窗口弹到用户桌面最前或抢焦点**：新增窗口/fixture 必须沿用同一开关，禁止 `show()` / `focus()` / `maximize()` 抢前台。
- 需要真实窗口位置/几何的用例（如 `window-memory`、`quick-task`）必须 `test.use({ e2eWindowMode: "visible" })`（fixture 下发 `PIDECK_E2E_WINDOW_MODE=visible`）；调试时同样设该环境变量。
- 摆放失败必须静默回退，不阻断 e2e。守卫：`tests/e2eWindowMode.test.mjs` + `e2e/window-background.spec.ts`。

## IPC 与 preload

- preload 不做业务，只做校验后的转发与订阅封装；通道名一律引用 `ipcChannels` 常量，不写字面量。
- 事件推送 preload 侧返回 unsubscribe 函数；渲染层卸载必须退订。

## 原生模块与打包

- node-pty 等原生模块必须 `asarUnpack` 并 postinstall 修权限（`scripts/fix-pty-permissions.js`）；afterPack 删 node_modules 冗余文件必须有对应测试（`tests/afterPackCleanup.test.mjs`）。
- 资源路径用 `process.resourcesPath` / `app.getAppPath()` 推导，禁止裸 `__dirname` 假设 asar 可读；preload 路径走 `preloadPath.ts`。
- **原生模块禁止顶层静态 import**：JS 包装可能在模块求值时同步加载对应平台二进制（koffi 即如此），跨 arch 打包时可选依赖（`@koromix/koffi-*`）不会自动跟随，缺二进制环境启动即崩（issue #313）。必须经专属模块函数内 `createRequire` 惰性加载 + try/catch 降级；守卫 `tests/cua/cuaKoffiFallback.test.mjs`，同约束见 `nodePtyRuntime.ts`。
- 安装器完成页的「运行 PiDeck」必须直接启动 `$INSTDIR\${APP_EXECUTABLE_FILENAME}`（`build/installer.nsh` 的 `customFinishPage`）。electron-builder 默认用 `$launchLink`，它优先取开始菜单 `PiDeck.lnk`，那条 .lnk 可能指向另一份同名同版本 PiDeck（解包构建/旧安装目录），装完点运行会跑错程序且版本号看着是对的。守卫 `tests/nsisFinishPageLaunch.test.mjs`。

## 跨平台

- 禁止硬编码 `/` 或 `\`；平台特判集中在专属模块（如 `linuxDisplayBackend.ts`）。
- Windows「偶发失败」优先怀疑路径空格、杀毒锁文件、长路径、权限弹窗；日志带足上下文。
- **WSL 项目的 git 一律走发行版内 git**：cwd 是 `\\wsl.localhost\...` UNC 时经 `wsl.exe -d <distro> … git` 执行（`src/main/git/gitWsl.ts`）。理由：宿主 git.exe 经 9P 会被判 dubious ownership，两套索引视角不一致会让仓库反复「整树改动」。
- **git 子进程只有两个入口**：`execGit`（读类）与 `runGitCommand`（写类），都在 `src/main/git/gitRun.ts` 收口；新增 git 调用不得绕过。
