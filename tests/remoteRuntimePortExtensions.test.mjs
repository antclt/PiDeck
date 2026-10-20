/**
 * 远端运行时端口的扩展注入决策（P4.4 扩展面）。
 *
 * 这组用例把「哪些扩展进远端命令行」钉成行为：版本门槛 / 诊断开关 / 部署失败 / 名单过滤 / env 通道，
 * 以及 UI 会看到的那份 `extensions` 结果（`applied` 是事实，不是“应该能”）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteRuntimePort } = loadTsCommonJs("src/main/pi/remoteRuntimePort.ts");
const { BUILT_IN_EXTENSIONS, INTERNAL_BUILT_IN_EXTENSIONS } = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");

const HOST_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REMOTE_CWD = "/srv/remote-app";
const SNAPSHOT_ROOT = "/home/dev/.pideck/remote-host/extensions/ab".concat("c".repeat(62));
const ALL_FILES = [...BUILT_IN_EXTENSIONS, ...INTERNAL_BUILT_IN_EXTENSIONS];
const FACTS = { nodePath: "/usr/local/bin/node", piPath: "/usr/local/bin/pi", version: "1.3.0", runnerPath: "/home/dev/.pideck/remote-host/bundles/deadbeef/runner.mjs", deployRoot: "/home/dev/.pideck/remote-host" };

/** 服务替身：部署结果与调用次数都由测试控制。 */
function createService(overrides = {}) {
	const calls = { deploy: 0, push: 0 };
	return {
		calls,
		async remotePiRuntimeFacts() {
			return { ...FACTS, ...(overrides.version === undefined ? {} : { version: overrides.version }) };
		},
		async ensureRemoteExtensionSnapshot() {
			calls.deploy += 1;
			return overrides.snapshot ?? { ok: true, sha256: "a".repeat(64), root: SNAPSHOT_ROOT, fileNames: ALL_FILES };
		},
		async pushSecurityPolicySnapshot() {
			calls.push += 1;
			if (overrides.pushFails === true) throw new Error("SECURITY_ARTIFACT_MISMATCH");
		},
		createPiRuntimeLauncher() {
			return {
				async launch() {
					throw new Error("LAUNCHER_NOT_USED");
				},
			};
		},
	};
}

function createPort(service, settings = {}, envChannelAvailable = false, securityPolicyBytes = () => Buffer.from("{}", "utf8")) {
	return createRemoteRuntimePort({
		resolveService: () => service,
		settings: () => settings,
		...(envChannelAvailable ? { envChannelAvailable: true } : {}),
		...(typeof securityPolicyBytes === "function" ? { securityPolicyBytes } : {}),
	});
}

const prepare = (port) => port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD });

test("版本低于 1.0.0：不部署、不注入，并如实给出原因", async () => {
	const service = createService({ version: "0.85.1" });
	const { plan, extensions } = await prepare(createPort(service));
	assert.deepEqual([...extensions.applied], []);
	assert.equal(extensions.reason, "REMOTE_PI_EXTENSIONS_UNSUPPORTED");
	assert.equal(service.calls.deploy, 0, "版本不够时不应白传快照");
	assert.equal(plan.args.includes("--extension"), false);
});

test("诊断开关 piRpcNoExtensions：与本地同语义，一个都不注入", async () => {
	const service = createService();
	const { plan, extensions } = await prepare(createPort(service, { piRpcNoExtensions: true }));
	assert.deepEqual([...extensions.applied], []);
	assert.equal(extensions.reason, "REMOTE_EXTENSIONS_DISABLED");
	assert.equal(service.calls.deploy, 0);
	assert.equal(plan.args.includes("--extension"), false);
});

test("快照部署失败：降级为无扩展，不阻塞会话，并带出稳定码", async () => {
	const service = createService({ snapshot: { ok: false, code: "BOOTSTRAP_FILE_MISMATCH" } });
	const { plan, extensions } = await prepare(createPort(service));
	assert.equal(extensions.reason, "REMOTE_EXTENSIONS_UNAVAILABLE");
	assert.equal(extensions.detail, "BOOTSTRAP_FILE_MISMATCH");
	assert.deepEqual([...extensions.applied], []);
	assert.equal(plan.args.includes("--extension"), false);
});

test("注入面：路径来自内容寻址根，顺序与内置表一致，UI 看到的是 basename", async () => {
	const service = createService();
	const { plan, extensions } = await prepare(createPort(service, {}, false));
	assert.ok(extensions.applied.length > 0);
	for (const name of extensions.applied) assert.equal(name.includes("/"), false, "UI 只拿 basename");
	const extensionArgs = plan.args.flatMap((arg, index) => (arg === "--extension" ? [plan.args[index + 1]] : []));
	assert.deepEqual(
		[...extensionArgs],
		[...extensions.applied].map((name) => `${SNAPSHOT_ROOT}/${name}`),
		"每个 applied 都必须对应一条 --extension，且路径在快照根下",
	);
	// 本机路径不得出现在远端命令行里（内容寻址根是远端 POSIX 路径）。
	for (const path of extensionArgs) assert.match(path, /^\/home\/dev\/\.pideck\/remote-host\/extensions\/[0-9a-f]{64}\//);
});

test("env 通道决定安全门是否注入（没有 env 就不假装有安全等级）", async () => {
	const withoutEnvService = createService();
	const withoutEnv = await prepare(createPort(withoutEnvService, {}, false));
	assert.equal(withoutEnv.extensions.applied.includes("pi-deck-security-gate.ts"), false);
	assert.equal(withoutEnvService.calls.push, 0, "没有 env 通道就不该写远端快照");
	const withEnv = await prepare(createPort(createService(), {}, true));
	assert.equal(withEnv.extensions.applied.includes("pi-deck-security-gate.ts"), true);
	assert.deepEqual(JSON.parse(JSON.stringify(withEnv.plan.env)), { PIDECK_SECURITY_CONFIG: `${FACTS.deployRoot}/security-policy.json` }, "会话 id 缺省时不传 PIDECK_SESSION_ID");
});

test("安全快照写失败/读不到：把安全门从注入面拿掉（不能“扩展在、策略没到”）", async () => {
	const failing = createService({ pushFails: true });
	const afterFailure = await prepare(createPort(failing, {}, true));
	assert.equal(afterFailure.extensions.applied.includes("pi-deck-security-gate.ts"), false);
	assert.equal(
		afterFailure.plan.args.some((arg) => typeof arg === "string" && arg.includes("security-gate")),
		false,
	);
	assert.equal(afterFailure.plan.env, undefined);

	const withoutBytes = createService();
	const afterMissing = await prepare(createPort(withoutBytes, {}, true, null));
	assert.equal(afterMissing.extensions.applied.includes("pi-deck-security-gate.ts"), false);
	assert.equal(withoutBytes.calls.push, 0);
});

test("会话 id 会随安全门 env 一起下发（等级覆盖按它查表）", async () => {
	const service = createService();
	const port = createPort(service, {}, true);
	const { plan } = await port.prepare({ hostId: HOST_ID, remoteCwd: REMOTE_CWD, sessionId: "session-record-1" });
	assert.deepEqual(JSON.parse(JSON.stringify(plan.env)), { PIDECK_SECURITY_CONFIG: `${FACTS.deployRoot}/security-policy.json`, PIDECK_SESSION_ID: "session-record-1" });
	assert.equal(service.calls.push, 1);
});

test("设置过滤：removed 与 autoSessionTitle=false 同步作用到远端", async () => {
	const service = createService();
	const { extensions } = await prepare(createPort(service, { removedBuiltInExtensions: ["pi-deck-plan-mode.ts"], autoSessionTitle: false }));
	assert.equal(extensions.applied.includes("pi-deck-plan-mode.ts"), false);
	assert.equal(extensions.applied.includes("pi-deck-session-title.ts"), false);
	assert.equal(extensions.applied.includes("pi-deck-goal-mode.ts"), true);
});

test("快照里不存在的文件不会被声称注入（旧/半截快照降级）", async () => {
	const service = createService({
		snapshot: { ok: true, sha256: "b".repeat(64), root: SNAPSHOT_ROOT, fileNames: ["pi-deck-plan-mode.ts"] },
	});
	const { plan, extensions } = await prepare(createPort(service));
	assert.deepEqual([...extensions.applied], ["pi-deck-plan-mode.ts"]);
	assert.deepEqual([...plan.args.flatMap((arg, index) => (arg === "--extension" ? [plan.args[index + 1]] : []))], [`${SNAPSHOT_ROOT}/pi-deck-plan-mode.ts`]);
});
