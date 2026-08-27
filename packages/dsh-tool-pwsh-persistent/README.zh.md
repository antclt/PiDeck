# dsh-tool-pwsh-persistent

DSH 的持久 PowerShell 工具。每个 agent 复用一个常驻 `pwsh`（`node-pty` + `-NoExit`），避免每次 `pwsh -Command` 冷启动约 350ms。

与官方 `@deepseek-ai/dsh-tool-bash-persistent` 同类，但**不依赖 `ctx.terminals`**。无沙箱。
官方 rc.8 的 `@deepseek-ai/dsh-tool-pwsh-persistent` 走 `ctx.terminals`、工具名是 `pwsh`（会和一次性沙箱 pwsh 冲突），本插件仍用独立工具名 `pwsh_persistent`。

## 不要装进 PiDeck 仓库

PiDeck 已经通过 `file:packages/dsh-tool-pwsh-persistent` 挂好了。开一个 DSH 会话即可，模型侧出现 `pwsh_persistent`。

也不要在任意目录执行 `npm install ./xxx.tgz` 再 `dsh plugin add dsh-tool-pwsh-persistent`：后者会去 **npm 仓库**拉同名包，本地 tgz 必然 404。

## 给 dsh-web / 官方 CLI 装

`dsh plugin` 只是在 `~/.dsh/profiles/<name>` 里跑 pnpm。本地包必须把 **tgz 路径**交给它，不能只写包名。

在 **tgz 所在目录**执行（Windows 没有全局 `dsh` 时用 npx）：

```powershell
npx @deepseek-ai/dsh plugin --profile web add ./dsh-tool-pwsh-persistent-0.1.2.tgz
```

绝对路径也可以：

```powershell
npx @deepseek-ai/dsh plugin --profile web add "D:\path\to\dsh-tool-pwsh-persistent-0.1.2.tgz"
```

CLI 会：

1. 在 `C:\Users\<你>\.dsh\profiles\web` 里 `pnpm add <tgz>`
2. 看到包里的 `dsh.bundle.patch`，把它写进该 profile 的 `dsh.profile.bundles`
3. 重启 dsh-web / `dsh` 后工具生效

`node-pty` 必须在对方 Node ABI 上重建。不要拷贝别人的 `node_modules`。

peer（由宿主提供）：`@deepseek-ai/dsh-tools` / `dsh-timeout` / `cordis` `^0.1.0-rc.8`。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `pwshPath` | 显式配置优先；Windows 依次扫描标准 PS7、PATH 中每项的绝对 `pwsh.exe`（含 WindowsApps App Execution Alias）、Windows PowerShell 5.1，最后才回退 `pwsh`；其它平台使用 `pwsh` | 可执行文件 |
| `timeoutMs` | `300000` | 单条命令超时 |
| `startupTimeoutMs` | `15000` | 首次等到自定义提示符 |
| `maxOutputChars` | `16000` | 输出截断 |
| `description` | 内置英文说明 | 给模型看的工具描述 |

Windows 候选用 `lstat` 检查目录项本身，因此即使 Store alias 的目标因 ACL 无法 `stat`，也能把完整的 WindowsApps `pwsh.exe` 路径交给 `node-pty` 启动。

如果启动仍然失败，错误信息会显示实际使用的 `pwshPath`，并给出安装 PowerShell 7 的命令：

```powershell
winget install --id Microsoft.PowerShell --source winget
```
