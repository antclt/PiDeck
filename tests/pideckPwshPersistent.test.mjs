import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  parsePwshCommandOutput,
  pwshPromptCompleted,
  stripPwshControl,
  wrapPwshCommand,
} = loadTsCommonJs("packages/dsh-tool-pwsh-persistent/src/protocol.ts");
const {
  candidatePwshPathExists,
  candidatePwshPaths,
  formatPwshStartupError,
  resolvePwshPath,
} = loadTsCommonJs("packages/dsh-tool-pwsh-persistent/src/pwshResolver.ts");

const fileStat = () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
});

const symlinkStat = () => ({
  isFile: () => false,
  isSymbolicLink: () => true,
});

test("resolvePwshPath：显式配置优先且不读取候选路径", () => {
  let checked = false;
  const configuredPath = "D:\\portable\\pwsh.exe";
  assert.equal(
    resolvePwshPath({
      configuredPath,
      platform: "win32",
      programFiles: "C:\\Program Files",
      lstat: () => {
        checked = true;
        return fileStat();
      },
    }),
    configuredPath,
  );
  assert.equal(checked, false);
});

test("candidatePwshPaths：按 PS7、PATH 和 Windows PowerShell 5.1 的顺序构造绝对候选", () => {
  assert.deepEqual(
    [...candidatePwshPaths({
      programFiles: "C:\\Program Files",
      pathEnv: " C:\\tools ;\"C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\";;",
      systemRoot: "C:\\Windows",
    })],
    [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\tools\\pwsh.exe",
      "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ],
  );
});

test("resolvePwshPath：Windows 标准 PS7 路径存在时直接使用", () => {
  const checkedPaths = [];
  assert.equal(
    resolvePwshPath({
      platform: "win32",
      programFiles: "C:\\Program Files",
      lstat: (path) => {
        checkedPaths.push(path);
        return fileStat();
      },
    }),
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  );
  assert.deepEqual(checkedPaths, ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]);
});

test("resolvePwshPath：使用 PATH 内 WindowsApps alias 的绝对 pwsh.exe", () => {
  const windowsApps = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
  const checkedPaths = [];
  assert.equal(
    resolvePwshPath({
      platform: "win32",
      programFiles: "C:\\Program Files",
      pathEnv: "C:\\tools;C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps",
      lstat: (path) => {
        checkedPaths.push(path);
        if (path === windowsApps) return symlinkStat();
        throw new Error("ENOENT");
      },
    }),
    windowsApps,
  );
  assert.deepEqual(checkedPaths, [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\tools\\pwsh.exe",
    windowsApps,
  ]);
});

test("candidatePwshPathExists：lstat 接受 alias link，拒绝目录与不可访问路径", () => {
  assert.equal(candidatePwshPathExists("C:\\WindowsApps\\pwsh.exe", symlinkStat), true);
  assert.equal(candidatePwshPathExists("C:\\directory", () => ({
    isFile: () => false,
    isSymbolicLink: () => false,
  })), false);
  assert.equal(candidatePwshPathExists("C:\\missing\\pwsh.exe", () => {
    throw new Error("EACCES");
  }), false);
});

test("resolvePwshPath：PATH 未命中后回退 Windows PowerShell 5.1", () => {
  const powershell51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  assert.equal(
    resolvePwshPath({
      platform: "win32",
      programFiles: "C:\\Program Files",
      pathEnv: "C:\\tools",
      systemRoot: "C:\\Windows",
      lstat: (path) => {
        if (path === powershell51) return fileStat();
        throw new Error("ENOENT");
      },
    }),
    powershell51,
  );
});

test("resolvePwshPath：所有 Windows 候选不存在时最后回退裸 pwsh", () => {
  assert.equal(
    resolvePwshPath({
      platform: "win32",
      programFiles: "C:\\Program Files",
      pathEnv: "C:\\tools",
      systemRoot: "C:\\Windows",
      lstat: () => {
        throw new Error("ENOENT");
      },
    }),
    "pwsh",
  );
});

test("resolvePwshPath：非 Windows 平台使用 PATH 中的 pwsh", () => {
  let checked = false;
  assert.equal(
    resolvePwshPath({
      platform: "linux",
      lstat: () => {
        checked = true;
        return fileStat();
      },
    }),
    "pwsh",
  );
  assert.equal(checked, false);
});

test("formatPwshStartupError：启动失败包含实际路径和 winget 修复命令", () => {
  const error = formatPwshStartupError(new Error("spawn pwsh ENOENT"), "pwsh");
  assert.match(error.message, /pwshPath: pwsh/);
  assert.match(error.message, /spawn pwsh ENOENT/);
  assert.match(error.message, /winget install --id Microsoft\.PowerShell --source winget/);
});

test("wrapPwshCommand：start/end marker + Invoke-Expression 包裹 + 单引号转义", () => {
  const marker = { start: "__DSH_PWSH_START_x__", end: "__DSH_PWSH_END_x:" };
  const wrapped = wrapPwshCommand("Write-Output 'hello'", marker);
  assert.match(wrapped, new RegExp(`Write-Output '${marker.start}'`));
  assert.match(wrapped, /Invoke-Expression -Command 'Write-Output ''hello'''/);
  // end marker 与退出码用独立语句输出（conpty 折行鲁棒：拆开也能解析）
  assert.match(wrapped, new RegExp(`Write-Output '${marker.end}'`));
  assert.match(wrapped, /Write-Output \$global:LASTEXITCODE$/);
  // 退出码归一：$LASTEXITCODE 空时按 $? 归一
  assert.match(wrapped, /if \(\$null -eq \$global:LASTEXITCODE\) \{ \$global:LASTEXITCODE = if \(\$\?\) \{ 0 \} else \{ 1 \} \}/);
});

test("wrapPwshCommand：命令内的单引号全部转义（'' 表示字面 '）", () => {
  const marker = { start: "S", end: "E:" };
  const wrapped = wrapPwshCommand("git log --format='%h' it's", marker);
  assert.match(wrapped, /Invoke-Expression -Command 'git log --format=''%h'' it''s'/);
});

test("parsePwshCommandOutput：提取 start~end 区间文本与退出码", () => {
  const marker = { start: "__S__", end: "__E__:" };
  const buffer = `\r\n__S__\r\nhello\r\nworld\r\n__E__:0\r\n`;
  const parsed = parsePwshCommandOutput(buffer, marker);
  assert.ok(parsed);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.text, "hello\nworld");
});

test("parsePwshCommandOutput：非零退出码与未完成命令", () => {
  const marker = { start: "__S__", end: "__E__:" };
  const parsed = parsePwshCommandOutput(`__S__\r\nboom\r\n__E__:7\r\n`, marker);
  assert.equal(parsed?.exitCode, 7);
  // 命令未结束（无 end marker）→ undefined
  assert.equal(parsePwshCommandOutput(`__S__\r\nrunning...`, marker), undefined);
  // 回显里的 end marker（后无数字）不算完成
  assert.equal(
    parsePwshCommandOutput(`echo __E__: echo __S__\r\n__S__\r\nok\r\n__E__:0\r\n`, marker)?.exitCode,
    0,
    "取最后一个 end marker（真实输出），回显里的被跳过",
  );
  // 退出码独立行（end marker 后换行再数字）：conpty 折行/独立语句输出形态
  const wrapped = parsePwshCommandOutput(`__S__\r\nout\r\n__E__:\r\n0\r\n`, marker);
  assert.equal(wrapped?.exitCode, 0);
  assert.equal(wrapped?.text, "out");
});

test("parsePwshCommandOutput：命令回显行（含 start 文本）被 lastIndexOf 跳过", () => {
  // PTY 交互回显 = 输入的 wrapped 命令原文（含 start marker），执行输出里 start marker 在后
  const marker = { start: "__S__", end: "__E__:" };
  const buffer = `\x1b[93m__S__\x1b[37m（回显的完整命令）\r\n__S__\r\nreal output\r\n__E__:0\r\n`;
  const parsed = parsePwshCommandOutput(buffer, marker);
  assert.equal(parsed?.text, "real output", "取最后一个 start marker 之后的内容，回显被排除");
});

test("stripPwshControl：剥离 CSI/OSC/模式切换序列（pwsh PTY 提示符输出）", () => {
  const raw = "\x1b[?9001h\x1b[?25l\x1b[2J\x1b[m\x1b[H__DSH_PERSISTENT_PWSH_PROMPT__\x1b[1C\x1b]0;title\x07\x1b[?25h";
  const clean = stripPwshControl(raw);
  assert.equal(clean, "__DSH_PERSISTENT_PWSH_PROMPT__");
});

test("pwshPromptCompleted：提示符完成判定（去控制序列后以提示符结尾）", () => {
  const promptTail = "__DSH_PERSISTENT_PWSH_PROMPT__\x1b[1C\x1b]0;x\x07";
  assert.equal(pwshPromptCompleted(`hello\r\n${promptTail}`), true);
  assert.equal(pwshPromptCompleted("hello\r\nPS C:\\work> "), false, "默认提示符不算完成");
  assert.equal(pwshPromptCompleted(""), false);
});
