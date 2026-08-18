import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  parsePwshCommandOutput,
  pwshPromptCompleted,
  stripPwshControl,
  wrapPwshCommand,
} = loadTsCommonJs("packages/dsh-tool-pwsh-persistent/src/protocol.ts");

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
