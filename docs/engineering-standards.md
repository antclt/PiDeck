# 工程标准（代码 / 测试 / 安全 / 兼容）

> 写代码、写测试、改 IPC 边界或处理用户数据前读本文。
> 命令与门禁速查见根 `AGENTS.md`；域运维细节见 `docs/maintenance-domains.md`。

## 代码风格

- TypeScript strict；禁止新增 `any`（第三方交互用 `unknown` + 收窄并注释）；禁止 `as` 强转绕过类型错误；测试数据用工厂函数构造完整对象。
- 命名：类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，IPC 通道 `domain:action`。
- React：函数组件 + hooks；副作用必须有清理；派生状态用 `useMemo`，可计算值不进 state。
- 日志走主进程 logging 模块，不留调试 `console.log`；用户可见错误走 toast/内联文案（i18n），不裸抛异常跨 IPC。

## 格式化（biome）

- 配置在根 `biome.jsonc`，覆盖 `src/`、`tests/`、`scripts/`、`e2e/`；`docs-site/`、`resources/extensions/`、CSS 不参与。
- 规则：tab 缩进、双引号、分号、尾逗号、LF；`lineWidth` 320 是刻意取上限——只统一缩进/空格/标点，不做实际折行，因为折行会打破大量「源码正则扫描」契约测试。
- 提交前 `npm run format`；CI 跑 `npm run check:format`，未格式化红灯。
- **新增源码正则扫描契约测试时，正则必须空白容忍**：用 `\s*` 而非字面空格，定位代码块用 `^[\t ]*` 锚点。否则改一次格式整组断言失败。
- `linter` 仍为 `enabled: false`；lint 规则按触达面增量启用，不一次性引入存量告警。

## 注释

- 对核心逻辑、复杂判断、业务规则、状态流转、权限校验、数据转换、异常处理注释「为什么、对应什么规则、边界是什么」，不逐行解释显而易见的代码。
- 新增函数/类/模块加简短功能说明；改旧代码时缺上下文的顺手补。
- 事故与历史决策写在注释或 `docs/maintenance-domains.md`，根 `AGENTS.md` 只留一行结论。

## 测试

测试在 `tests/*.test.mjs`（node --test）。日常只跑**针对性测试**；全量 `npm test` 仅跨域大改动或合并前最终确认时运行。

1. **必过门禁**：合并前 `npm run typecheck` + 改动涉及的针对性测试全绿，不许「先合再修」。
2. **何时必须写**：修 bug 先写复现测试（红）再修到绿，回归测试永久保留；新增主进程业务逻辑、数据转换/解析/状态机必须有单测；交互状态流转的 hook 应有测试，纯 UI 布局不强求。
3. **写法**：测行为不测实现（从公开接口/IPC 边界断言）；不依赖执行顺序、真实网络、真实 pi 进程；一个测试验证一件事，命名即意图。
4. **加载生产 TS 模块用现成 helper，禁止手写 vm 加载器**：
   - 完整依赖图用 `tests/helpers/loadTsCommonJs.mjs`；自定义 sandbox 全局用 `tests/helpers/createTsSandbox.mjs`。
   - 两者的相对 import 按源文件目录解析。手写沙箱把 specifier 丢给 `require(specifier)` 会以 `tests/` 为基准，生产代码新增本地 import 就整片 MODULE_NOT_FOUND。
   - 沙箱不注入 Node 全局（`setTimeout`/`clearTimeout` 等）；被 vm 加载的生产模块用定时器时必须显式 `import { setTimeout } from "node:timers"`。
5. **红名单归属判定**：全量测试出现失败时，先用 `git worktree add` 在改动前基线 commit 复跑同一批测试文件——基线也红的是上游/并行改动，不顺手修也不算进自己的回归；只修自己引入的。
6. **禁止**：放宽断言、注释掉失败测试、改成恒真。**不得为了让新代码通过而改写/删除现有测试**：存量测试即使使用了已禁止的写法（如手写 vm 加载器），也不要在无关任务里顺手替换——要么保持不动，要么另开任务重写并保留原断言。

## 安全

1. **IPC 最小权限**：preload 只暴露页面需要的 API，禁止 `ipcRenderer` 透传。
2. **输入校验在边界**：IPC handler 第一行职责是校验入参（类型/路径合法性/枚举范围）；渲染层数据一律不可信。
3. **路径安全**：文件读写限制在项目目录或应用数据目录内；拼接前规范化 + 逃逸检查，禁止直接拼用户输入。
4. **进程调用**：spawn/exec 参数必须数组形式，禁止字符串插值拼 shell；子进程环境变量经 `sanitizePiChildEnv` 类函数清洗；所有 spawn（含 fire-and-forget 的 `open`/`taskkill`/安装器）必须挂 `error` 监听或等价兜底——未处理的 `error` 事件会直接崩主进程；可能长时间不返回的外部命令（如 `reg query /s`）必须带超时 kill。
5. **Webview**：禁止加载 `file://` 以外任意本地内容；`allowpopups`/node integration 保持最小化，新增 webview 属性需评审。
6. **密钥与令牌**：Auth 配置只经 `config/` 模块读写；日志/错误上报/遥测禁止输出 token/key。
7. **依赖引入**：新增依赖需说明理由，优先用已有能力，禁止为小功能引重型库。

## 稳定性与可扩展性

1. **错误处理分层**：主进程 catch 后写日志 + 返回结构化错误；渲染层用户可感知错误走 toast/内联文案；异步函数禁止无 catch 的裸 promise。
2. **生命周期配对**：注册 listener/timer/子进程/watcher 的地方，同一模块必须有清理路径；退出清单统一登记到 `QuitCleanupRegistry`。
3. **资源边界**：大文件读取、会话扫描、diff 计算要有大小上限或流式处理；渲染进程不做全量日志/历史的主存。
4. **向后兼容**：设置项、会话文件、缓存格式变更必须有迁移或默认值兜底；删旧字段前保留一个版本读取兼容。
5. **特性开关**：高风险/实验功能必须可从设置关闭/回退，默认取保守项。
6. **扩展点**：新增能力优先注册式（IPC 域注册、面板注册），不在既有 switch/if 链上加分支。

## i18n 文案

- 用户可见文本一律走词典，JSX 禁止硬编码中英文。
- 四组词典：`rendererCopy.*`、`mainProcessCopy.*`、`WebI18n.*`、`FeishuI18n.*`；zh-CN 与 en-US 同步加 key。词典清单与 locale 分支点见 `docs/maintenance-domains.md` §繁体中文。
- **改任何 zh-CN 词典后必须重跑 `node scripts/genZhTwCopy.mjs`**；四份 `*.zh-TW.ts` 是生成物，禁止手改。
- 漏跑的表现：先 typecheck 报 TS2739；只改值不加 key 则由 `source-sha256` 指纹门禁拦下。
