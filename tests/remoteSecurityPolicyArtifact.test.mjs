/**
 * 远端安全策略快照写入（P4.4 扩展面）。
 *
 * 契约面：固定命令 token 顺序、闭集错误码、结果解析；行为面：真实子进程跑冻结脚本，
 * 校验原子写入、sha/字节数不匹配时拒绝且不覆盖旧文件。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_SECURITY_ARTIFACT_ENTRY, REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE, REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX, REMOTE_SECURITY_ARTIFACT_MAX_BYTES, REMOTE_SECURITY_ARTIFACT_CODES, buildRemoteSecurityArtifactCommand, parseRemoteSecurityArtifactResult, remoteSecurityArtifactMarker, remoteSecurityPolicyPath } =
	loadTsCommonJs("src/main/remote/RemoteSecurityPolicyArtifact.ts");

const POSIX = typeof process.getuid === "function";
const DEPLOY_ROOT = "/home/dev/.pideck/remote-host";
const NONCE = "abcdef0123456789";
const MARKER = `${REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX}${NONCE}`;
const BODY = Buffer.from(JSON.stringify({ schemaVersion: 1, enabled: true, defaultLevelId: "standard", levels: [], sessionLevels: { s1: "strict" } }), "utf8");
const SHA = createHash("sha256").update(BODY).digest("hex");

test("固定命令：token 顺序固定，路径与 sha 逐个校验", () => {
	const { command, marker } = buildRemoteSecurityArtifactCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bytes: BODY.length, sha256: SHA, nonce: NONCE });
	assert.equal(marker, MARKER);
	assert.ok(command.includes(`'${REMOTE_SECURITY_ARTIFACT_ENTRY}'`));
	assert.ok(command.endsWith(`'${MARKER}' '${DEPLOY_ROOT}' '${SHA}' '${BODY.length}'`), "marker/deployRoot/sha/bytes 的顺序是契约");
	assert.equal(remoteSecurityPolicyPath(DEPLOY_ROOT), `${DEPLOY_ROOT}/security-policy.json`);

	for (const bad of [
		{ nodePath: "/bin/sh" },
		{ nodePath: "node" },
		{ deployRoot: "/home/dev/.pideck/remote-host/" },
		{ deployRoot: "relative/root" },
		{ deployRoot: "C:/Users/dev" },
		{ bytes: -1 },
		{ bytes: REMOTE_SECURITY_ARTIFACT_MAX_BYTES + 1 },
		{ bytes: 1.5 },
		{ sha256: SHA.toUpperCase() },
		{ sha256: SHA.slice(1) },
		{ nonce: "short" },
		{ nonce: "has space 000000" },
	]) {
		assert.throws(
			() => buildRemoteSecurityArtifactCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bytes: BODY.length, sha256: SHA, nonce: NONCE, ...bad }),
			(error) => error.message === REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid,
			`must refuse ${JSON.stringify(bad)}`,
		);
	}
	assert.throws(
		() => remoteSecurityPolicyPath("relative"),
		(error) => error.message === REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid,
	);
});

test("结果解析：只接受闭集形状", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(parseRemoteSecurityArtifactResult(`${MARKER}{"ok":true,"bytes":3}`, MARKER))), { ok: true, bytes: 3 });
	for (const code of Object.values(REMOTE_SECURITY_ARTIFACT_CODES)) {
		assert.throws(
			() => parseRemoteSecurityArtifactResult(`${MARKER}{"ok":false,"code":"${code}"}`, MARKER),
			(error) => error.message === code,
		);
	}
	for (const stdout of ["", `${MARKER}{"ok":false,"code":"NOT_A_CODE"}`, `${MARKER}{"ok":true,"bytes":-1}`, `${MARKER}{"ok":true,"bytes":${REMOTE_SECURITY_ARTIFACT_MAX_BYTES + 1}}`, `${MARKER}{"ok":true`, `${MARKER}[]`]) {
		assert.throws(
			() => parseRemoteSecurityArtifactResult(stdout, MARKER),
			(error) => error.message === REMOTE_SECURITY_ARTIFACT_CODES.internal,
		);
	}
	assert.throws(
		() => remoteSecurityArtifactMarker("short"),
		(error) => error.message === REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid,
	);
});

/** 在临时 HOME 下跑真实冻结脚本；deployRoot 由 HOME 推导（与生产一致）。 */
function runScript(t, { body = BODY, sha = SHA, bytes = BODY.length, deployRoot } = {}) {
	const home = mkdtempSync(join(tmpdir(), "pideck-security-artifact-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	const root = deployRoot ?? join(home, ".pideck", "remote-host");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	if (POSIX) {
		mkdirSync(join(home, ".pideck"), { recursive: true, mode: 0o700 });
	}
	const result = spawnSync(process.execPath, ["-e", REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE, "--", REMOTE_SECURITY_ARTIFACT_ENTRY, MARKER, root, sha, String(bytes)], {
		env: { ...process.env, HOME: home },
		input: `${Buffer.from(body).toString("base64")}\n`,
		encoding: "utf8",
	});
	return { result, root, home };
}

test("真实脚本：校验后原子写入，文件字节与声明一致", (t) => {
	const { result, root } = runScript(t);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.slice(result.stdout.indexOf(MARKER) + MARKER.length)), { ok: true, bytes: BODY.length });
	const target = join(root, "security-policy.json");
	assert.deepEqual(readFileSync(target), BODY);
	if (POSIX) assert.equal((statSync(target).mode & 0o777).toString(8), "600");
	assert.equal(existsSync(`${target}.tmp`), false, "临时文件必须已被 rename 掉");
});

test("真实脚本：sha 或字节数不匹配就拒绝，且不覆盖已有快照", (t) => {
	const { result, root } = runScript(t, { sha: "a".repeat(64) });
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /SECURITY_ARTIFACT_MISMATCH/);
	assert.equal(existsSync(join(root, "security-policy.json")), false);

	// 已有旧快照时，错误内容不得把它改坏。
	const previous = Buffer.from('{"schemaVersion":1,"enabled":false}', "utf8");
	const home = mkdtempSync(join(tmpdir(), "pideck-security-artifact-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	const deployRoot = join(home, ".pideck", "remote-host");
	mkdirSync(deployRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(deployRoot, "security-policy.json"), previous);
	const mismatch = spawnSync(process.execPath, ["-e", REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE, "--", REMOTE_SECURITY_ARTIFACT_ENTRY, MARKER, deployRoot, SHA, String(BODY.length + 1)], {
		env: { ...process.env, HOME: home },
		input: `${BODY.toString("base64")}\n`,
		encoding: "utf8",
	});
	assert.notEqual(mismatch.status, 0);
	assert.deepEqual(readFileSync(join(deployRoot, "security-policy.json")), previous, "失败的写入不得覆盖旧快照");
});

test("真实脚本：部署根不是 <HOME>/.pideck/remote-host 就拒绝", (t) => {
	const home = mkdtempSync(join(tmpdir(), "pideck-security-artifact-"));
	t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	const other = join(home, "somewhere-else");
	mkdirSync(other, { recursive: true, mode: 0o700 });
	const result = spawnSync(process.execPath, ["-e", REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE, "--", REMOTE_SECURITY_ARTIFACT_ENTRY, MARKER, other, SHA, String(BODY.length)], {
		env: { ...process.env, HOME: home },
		input: `${BODY.toString("base64")}\n`,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /SECURITY_ARTIFACT_ROOT_INVALID/);
	assert.equal(existsSync(join(other, "security-policy.json")), false);
});
