import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 远程配置面板（参照 ZCode 的结构）：类型切换 + 实时预览 + 表单 + SSH config 导入。
// 关键契约不变：只提供底层真能执行的选项；密码/口令在 BatchMode 下没有通道，就不画输入框。

const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("form carries username, auth mode and private key", () => {
	assert.match(dialog, /const EMPTY_FORM = \{[\s\S]*?port: "22",[\s\S]*?auth: "agent" as AuthMode,[\s\S]*?identityFile: "",\s*\};/);
	assert.match(dialog, /const \[form, setForm\] = useState<FormState>\(EMPTY_FORM\)/);
	assert.match(dialog, /id="remote-host-user"/);
	assert.match(dialog, /id="remote-host-identity"/);
	// 私钥路径不做渲染层展开：~ 由主进程规范化。
	assert.match(dialog, /\.\.\.\(user\.length > 0 \? \{ user \} : \{\}\)/);
	assert.match(dialog, /\.\.\.\(identityFile\.length > 0 \? \{ identityFile \} : \{\}\)/);
	assert.match(dialog, /form\.auth === "key" && identityFile\.length === 0/);
});

test("SSH config import fills the form instead of submitting silently", () => {
	assert.match(dialog, /const applyCandidate = useCallback\(\(candidate: RemoteHostConfigCandidate\) => \{/);
	assert.match(dialog, /auth: candidate\.identityFile === null \? "agent" : "key"/);
	assert.match(dialog, /setImporting\(false\)/);
	// 候选被过滤后仍要说明「被跳过」的原因。
	assert.match(dialog, /settings\.connections\.add\.skipped/);
});

test("type switch shows WSL and Docker but never as working tabs", () => {
	const wsl = dialog.match(/<TerminalSquare[\s\S]{0,200}?kind\.wsl/);
	const docker = dialog.match(/<Box[\s\S]{0,200}?kind\.docker/);
	assert.ok(wsl && docker, "both unsupported kinds are visible");
	// 两者都必须是 disabled：当前后端只有 SSH 主机。
	assert.equal((dialog.match(/aria-pressed="false"\s+disabled/g) ?? []).length, 2);
	assert.match(dialog, /kindUnavailable/);
});

test("no password field is offered while the transport refuses it", () => {
	assert.doesNotMatch(dialog, /type="password"/);
	assert.match(dialog, /auth\.passwordUnsupported/);
	assert.match(dialog, /aria-disabled="true"/);
});

test("the header preview reflects the current target", () => {
	assert.match(dialog, /settings\.connections\.add\.previewPlaceholder/);
	assert.match(dialog, /previewHost\.length === 0[\s\S]{0,40}previewPlaceholder/);
});
