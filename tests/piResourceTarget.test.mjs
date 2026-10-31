import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源作用域目标（W1）：输入校验 + 档案→发行版 HOME 解析。
 *
 * 断言按行为：目标在触达任何端口前被校验成闭集，解析失败只回稳定码，
 * 解析成功时 home 必须是该发行版 HOME 的 UNC 路径（技能/提示词/扩展都挂在这个 home 下）。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const target = loadTsCommonJs("src/main/config/piResourceTarget.ts");
const resolverModule = loadTsCommonJs("src/main/config/PiResourceTargetResolver.ts");
const wslPaths = loadTsCommonJs("src/main/wsl/WslPaths.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function codeOf(run) {
	try {
		run();
		return "ALLOWED";
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
}

function profile(overrides = {}) {
	return { id: HOST, label: "Ubuntu dev", distro: "Ubuntu-26.04", user: "dev", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function createResolver(overrides = {}) {
	return resolverModule.createPiResourceTargetResolver({
		listProfiles: async () => [profile()],
		resolveEnvironment: async (distro, user) => wslPaths.createWslEnvironment(distro, user, "/home/" + user),
		localHome: () => "C:\\Users\\me",
		...overrides,
	});
}

test("资源目标闭集：local 缺省，wsl 只认 hostId，ssh 明确拒绝而不是落到本机", () => {
	const strip = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(strip(target.readPiResourceTarget(undefined)), { kind: "local" });
	assert.deepEqual(strip(target.readPiResourceTarget(null)), { kind: "local" });
	assert.deepEqual(strip(target.readPiResourceTarget({ kind: "local" })), { kind: "local" });
	assert.deepEqual(strip(target.readPiResourceTarget({ kind: "wsl", hostId: HOST })), { kind: "wsl", hostId: HOST });

	// ssh 在配置域是合法目标，但资源域本轮不路由；必须是专属稳定码，不能 coerce 成 local。
	assert.equal(
		codeOf(() => target.readPiResourceTarget({ kind: "ssh", hostId: HOST })),
		shared.PI_RESOURCE_CODES.sshUnsupported,
	);
	for (const bad of [{ kind: "wsl" }, { kind: "wsl", hostId: "" }, { kind: "wsl", hostId: "not-a-host" }, { kind: "wsl", hostId: HOST, extra: 1 }, { kind: "wsl", hostId: 42 }, { kind: "bogus" }, { kind: "local", hostId: HOST }]) {
		assert.equal(
			codeOf(() => target.readPiResourceTarget(bad)),
			shared.PI_RESOURCE_CODES.targetInvalid,
			JSON.stringify(bad),
		);
	}
});

test("资源 options 只接受 target 键：未知字段被拒绝，不静默忽略", () => {
	const strip = (value) => JSON.parse(JSON.stringify(value));
	assert.deepEqual(strip(target.readPiResourceOptions(undefined)), {});
	assert.deepEqual(strip(target.readPiResourceOptions({ target: { kind: "local" } })), { target: { kind: "local" } });
	assert.equal(
		codeOf(() => target.readPiResourceOptions({ target: { kind: "local" }, force: true })),
		shared.PI_RESOURCE_CODES.targetInvalid,
	);
	assert.equal(
		codeOf(() => target.readPiResourceOptions("local")),
		shared.PI_RESOURCE_CODES.targetInvalid,
	);
});

test("local 目标解析本机 HOME，不读档案端口", async () => {
	let profileReads = 0;
	const resolver = createResolver({ listProfiles: async () => ((profileReads += 1), [profile()]) });
	const resolved = await resolver.resolve({ kind: "local" });
	assert.equal(resolved.kind, "local");
	assert.equal(resolved.home, "C:\\Users\\me");
	assert.equal(resolved.cacheKey, "local");
	assert.equal(profileReads, 0);
});

test("wsl 目标：档案 → 发行版 HOME（UNC），cacheKey 含 hostId/distro/user", async () => {
	const resolver = createResolver();
	const resolved = await resolver.resolve({ kind: "wsl", hostId: HOST });
	assert.equal(resolved.kind, "wsl");
	assert.equal(resolved.hostId, HOST);
	assert.equal(resolved.distro, "Ubuntu-26.04");
	assert.equal(resolved.user, "dev");
	assert.equal(resolved.home, "\\\\wsl.localhost\\Ubuntu-26.04\\home\\dev");
	assert.equal(resolved.environment.linuxHome, "/home/dev");
	assert.equal(resolved.cacheKey, "wsl:" + HOST + ":Ubuntu-26.04:dev");
});

test("解析失败只回稳定码：缺档案 / 发行版不可用 / 环境与档案不符 / ssh", async () => {
	const missing = createResolver({ listProfiles: async () => [] });
	await assert.rejects(missing.resolve({ kind: "wsl", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.hostNotFound });

	const broken = createResolver({ resolveEnvironment: async () => Promise.reject(new Error("wsl.exe failed")) });
	await assert.rejects(broken.resolve({ kind: "wsl", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.distroUnavailable });

	// 发行版改名 / printenv 回退后解析出的环境与档案对不上：宁可拒绝，也不写到另一个发行版目录。
	const mismatched = createResolver({ resolveEnvironment: async (_distro, user) => wslPaths.createWslEnvironment("Ubuntu-24.04", user, "/home/" + user) });
	await assert.rejects(mismatched.resolve({ kind: "wsl", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.unavailable });

	// 端口给出的稳定码原样透出（装配层用它表达「解析出的环境与档案对不上」）。
	const stablePort = createResolver({ resolveEnvironment: async () => Promise.reject(new Error(shared.PI_RESOURCE_CODES.unavailable)) });
	await assert.rejects(stablePort.resolve({ kind: "wsl", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.unavailable });

	// 档案端口本身读不出来：不能当成「没有档案」退回本机。
	const storeBroken = createResolver({ listProfiles: async () => Promise.reject(new Error("EACCES")) });
	await assert.rejects(storeBroken.resolve({ kind: "wsl", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.unavailable });

	let resolverCalls = 0;
	const resolver = createResolver({ listProfiles: async () => ((resolverCalls += 1), [profile()]) });
	await assert.rejects(resolver.resolve({ kind: "ssh", hostId: HOST }), { message: shared.PI_RESOURCE_CODES.sshUnsupported });
	assert.equal(resolverCalls, 0, "ssh target must be rejected before the host store is read");
});

test("P1 稳定码是闭集，渲染层可从 IPC 前缀错误里抓码", () => {
	const expected = ["PI_RESOURCE_TARGET_INVALID", "PI_RESOURCE_SSH_UNSUPPORTED", "PI_RESOURCE_WRITE_UNSUPPORTED", "PI_RESOURCE_HOST_NOT_FOUND", "PI_RESOURCE_DISTRO_UNAVAILABLE", "PI_RESOURCE_UNAVAILABLE"];
	assert.deepEqual(Object.values(shared.PI_RESOURCE_CODES).sort(), [...expected].sort());
	for (const code of expected) assert.ok(shared.PI_RESOURCE_CODE_SET.has(code), code);
	const error = new Error("Error invoking remote method 'prompts:list': Error: PI_RESOURCE_HOST_NOT_FOUND");
	assert.equal(shared.piResourceCodeFromError(error), "PI_RESOURCE_HOST_NOT_FOUND");
	assert.equal(shared.piResourceCodeFromError(new Error("WSL_CONFIG_HOST_NOT_FOUND")), undefined);
});
