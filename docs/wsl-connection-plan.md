# WSL 连接一等化计划

> 状态：**设计完成，待实施**。目标是把 WSL 从「设置里的全局开关」提升为与 SSH 并列的连接类型；本计划只覆盖设计、迁移顺序与门禁，实施按 Wave 分批提交。
> 非目标：Docker、远端 daemon、密码认证。

## 1. 结论

- WSL 使用**独立的连接档案存储**（`WslHostStore`），不并入 `RemoteHostStore`。SSH store 的 pin/route/TOFU 语义对 WSL 不成立，混入会让两套信任模型互相污染。
- 档案字段只有 `{ id, label, distro, user, createdAt, updatedAt }`，不含任何秘密。
- 项目与会话记录增加可选的 `wslHostId`，保留现有 `wslDistro` / `wslUser` 兼容字段；读取侧缺 `wslHostId` 时按旧字段回退。
- 运行时不再读 `settings.wslEnabled / wslDistro / wslUser`，改为由项目/会话解析出 `WslEnvironment` 后显式传入。先迁移所有消费面，最后删除开发页开关。

## 2. 现状（证据）

- `wslEnabled / wslDistro / wslUser` 在 main 约 230 处被引用；其中 `src/main/index.ts` 50 处、`SessionCatalog.ts` 49 处，另有 `AgentManager`、`PiLocator`、`SessionRuntimeCoordinator`、`gitIpc`、`TerminalSessionLauncher`、`piMcpCli`。
- `projectsIpc.projectsAdd` 在 `settings.wslEnabled` 时把全局 distro/user 传给 `ProjectStore.chooseAndAdd(env, wslEnvironment)`。
- `ProjectLocator` 的 local 分支只有 `wslDistro`（没有 user、没有 host id）；`SessionRecord` 有 `wslDistro` 与 `wslUser`。
- `ConfigManager.configureWsl()`、`PromptManager` / `SkillManager` / `ExtensionManager` 的同类方法通过修改单例的「当前 home」切环境；[远端开发计划](remote-development-plan.md) 已明确禁止继续扩展这套全局切换。

## 3. 目标模型

### 3.1 WSL 档案

```ts
type WslHostProfile = {
  id: string;              // UUID，退役后不复用
  label: string;           // 连接页显示名
  distro: string;          // wsl.exe -d 的发行版名
  user: string;            // Linux 用户
  createdAt: string;
  updatedAt: string;
};
```

存储 `wsl-hosts.json`，沿用现有 version/revision、temp + backup、durable replace 协议。不保存密码、不保存 home 推导结果（可刷新缓存）。

### 3.2 引用与移除

- 项目引用：local locator 增加 `wslHostId`；现有 `wslDistro` 保留。
- 会话引用：`SessionRecord` 增加可选 `wslHostId`，与 `wslDistro` / `wslUser` 并存。
- 移除档案前扫描项目与会话（含归档、tombstone），仍有引用时返回 `WSL_HOST_REFERENCED`，不删除任何 WSL 内数据。
- 档案 id 退役后写入 retired 列表，永不复用；清理只涉及本机档案文件。

### 3.3 项目与会话

- 新建 WSL 项目时从所选档案写入 `wslHostId + distro + user`。
- 启动会话、扫描会话、pi 定位、配置/信任/Git/终端一律以「项目 → 档案」为准；会话记录里的身份字段用于校验档案是否被改动。
- 档案的 distro/user 修改后，旧项目继续引用同一 id；启动前比对记录值，不一致时按 `WSL_HOST_CHANGED` 拒绝并要求用户重选，避免悄悄换环境。

## 4. 迁移

1. 首次启动且 `wslEnabled && wslDistro && wslUser`：创建默认档案（label 使用 distro），记录迁移标记。
2. 现有 WSL 项目按 `(distro, user)` 匹配默认档案并回填 `wslHostId`；匹配不到（全局 user 已变）时保留旧字段，首次打开项目时提示重选档案，不自动猜测。
3. 现有会话按 `(wslDistro, wslUser)` 回填；缺失 user 的历史会话仅在全局设置仍匹配时回填。
4. 兼容窗口内，缺 `wslHostId` 的项目/会话继续读旧字段；一个版本后删除回退分支。
5. 开发页 WSL 配置在 Wave 5 删除，设置键保留只读兼容读取，不再写入。

## 5. 实施 Wave

| Wave | 内容 | 门禁 |
| --- | --- | --- |
| W1 | `WslHostStore` + 编解码 + IPC（list/add/update/remove）+ 引用扫描 | 定向单测、codec/恢复/并发写、移除引用保护 |
| W2 | 连接页列出 WSL 档案、新增弹窗 WSL 页创建档案、移除确认 | `tsc`、连接页契约测试、i18n 三份同步 |
| W3 | 项目添加按档案写入 locator；旧项目打开时补选档案 | 项目编解码兼容、添加/补选测试 |
| W4 | 运行时改造：会话创建、扫描、pi 定位、配置/信任/Git/终端显式接收 `WslEnvironment` | 每处替换都要有双发行版测试；禁止新增 `configureWsl` 调用 |
| W5 | 迁移默认档案、回填引用、删除开发页 WSL 配置与运行时全局读取 | 迁移幂等测试、旧数据回放、设置页快照 |
| W6 | 真机验收：两个发行版、失效发行版、档案移除与引用保护 | Windows + WSL 实机脚本/手工清单 |

W1–W3 可以并行评审但必须按序合并；W4 是风险最高的一波，合并前不允许同时改 `SessionCatalog` 与 `SessionRuntimeCoordinator` 的其它特性。

## 6. 风险与约束

- **单例管理器**：`ConfigManager` / `PromptManager` / `SkillManager` / `ExtensionManager` 目前靠全局切换 home。W4 必须改为「每次调用显式传入环境」或按档案实例化，不能继续扩展现有全局切换，否则两个 WSL 项目并发会串环境。
- **会话身份**：`SessionCatalog` 的扫描身份包含 distro/user。新增 `wslHostId` 不得改变已有 identity key，避免迁移后同一会话重复出现。
- **引用扫描**：必须覆盖归档会话与 tombstone；否则移除档案会留下不可解析的 locator。
- **失败语义**：发行版不存在、用户不存在、wsl.exe 不可用都返回稳定码；不回退到本机或其它发行版。
- **回滚**：保留旧字段与旧读取分支一个版本；档案文件可整体忽略，项目仍按旧字段运行。

## 7. 验收清单

- 两个发行版各自添加项目，文件树、会话、Git、终端、信任与配置读取都落在正确环境。
- 会话扫描只返回当前档案对应发行版的会话；切换项目不会串档。
- 移除未引用档案成功且不影响 WSL 内数据；仍被项目/会话引用时被拒绝并给出可行动文案。
- 迁移幂等：重复启动不重复建档、不改写已回填的引用。
- 开发页不再出现 WSL 配置；旧设置键只读兼容。
- 所有新增/失败路径有中英文案与稳定码。

## 8. 不做

- Docker 连接（无后端）。
- 远端 daemon / 断线继续执行。
- 密码与 passphrase 认证。
- 跨档案复制项目或会话。
