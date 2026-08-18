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
