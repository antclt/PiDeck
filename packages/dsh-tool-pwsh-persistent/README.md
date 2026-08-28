# dsh-tool-pwsh-persistent

[中文](README.zh.md)

Persistent PowerShell tool for DSH.

**Do not `npm install` the tarball into the PiDeck repo**, and **do not** `dsh plugin add dsh-tool-pwsh-persistent` (that hits the npm registry → 404).

## Testers (dsh-web / official CLI)

From the directory that contains the tarball:

```powershell
npx @deepseek-ai/dsh plugin --profile web add ./dsh-tool-pwsh-persistent-0.1.2.tgz
```

`dsh plugin` is a pnpm forwarder into `~/.dsh/profiles/web`. The spec must be a **path to the tgz**, not the bare package name.

## Configuration

When `pwshPath` is empty, the plugin reuses the official `@deepseek-ai/dsh-pwsh-local` resolver — the same one behind the regular `pwsh` tool — so both tools always pick the same executable. On Windows it prefers an explicit `pwshPath`, then the standard PowerShell 7 path, an absolute `pwsh.exe` under each `PATH` entry (the Microsoft Store payload is found this way; WindowsApps App Execution Aliases are accepted via `lstat`), then Windows PowerShell 5.1, and finally falls back to the literal `pwsh`. Other platforms use `pwsh` directly. An explicit `pwshPath` always takes precedence.

If startup still fails, the error includes the resolved `pwshPath` and this install command:

```powershell
winget install --id Microsoft.PowerShell --source winget
```
