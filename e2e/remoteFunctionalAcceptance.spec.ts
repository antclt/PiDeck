import { expect, type Page } from "@playwright/test";
import { frozenHelperBundleManifest } from "../src/main/remote/RemoteBootstrapDeployment";
import { REMOTE_ACCEPTANCE_ENV, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, runRemoteCommand, test } from "./remote-fixtures";

/**
 * 远端功能优化（F1–F4）的真机验收：docs/remote-functional-optimization-plan.md §4 F5。
 *
 * 驱动方式：主机生命周期走**产品自身的 preload IPC**（`piDesktop.remoteHosts.add/connect/disconnect`、
 * `piDesktop.remoteSessions.scan`）——这正是设置页与侧栏背后的同一条主进程路径，`out/renderer` 里的界面
 * 只是它的消费者；本机 `out/renderer` 是早于本轮 renderer 改动的构建产物，用点击驱动会把「界面版本」
 * 混进验收结论，所以这里不点设置页。
 *
 * 观察面（独立证据，全部来自远端主机或主进程返回值）：
 * - F1：冷部署（先把本版本 bundle 暂时移开；有活跃 lease 时不动）中 `disconnect` → 主进程 connect 返回
 *   `SSH_HOST_DISCONNECTED`，且本 run 的 bundle / staging / 部署锁 / bootstrap 进程全不残留；
 * - F1：随后立即重试 → 一次真实冷部署完成（bundle 被激活）；
 * - F3：断开再连接 → bundle 集合不变、无 staging（复用命中，不重复上传）；
 * - F4：1500 条真机会话夹具的整表扫描经产品 IPC 完成，且每条夹具都出现在结果里。
 *
 * 不覆盖（明确记录）：F2 的「满载 + 重复 cancel + 慢读」需要故障注入，真机 UI 路径无法稳定驱动，仍由
 * 离线用例承担（`remoteControlClientCancelBudget` / `sshLauncherStdinBackpressure`）；设置页点击路径由
 * 既有两份 acceptance spec 负责，它们与本轮无关的合同冲突见计划 §7.2。
 */
const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";
/**
 * 会话夹具条数：远端会话上限是 2000 个文件（frozen），而该主机已有用户的真实会话，所以取一个留足余量的
 * 规模。1500 条已经需要 24 批元数据，足以证明「按批取」在真机上工作。
 */
const FIXTURE_SESSIONS = 1500;
/** 本客户端当前会部署的 bundle 身份：冷/热部署的判据，不手写 sha。 */
const OUR_BUNDLE = frozenHelperBundleManifest().bundleSha256;

const unique = (values: string[]) => values.slice().sort();

function credentialsOrThrow() {
	if (credentials === undefined) throw new Error("remote credentials are required");
	return credentials;
}

const deployRootOf = (home: string) => home + "/.pideck/remote-host";

/** 本 run 在远端部署根下看到的 bundle 目录名（不含 staging、锁与临时副本）。 */
async function listBundles(home: string): Promise<string[]> {
	const result = await runRemoteCommand(credentialsOrThrow(), "ls " + deployRootOf(home) + "/bundles 2>/dev/null || true", 30_000);
	return unique(
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[0-9a-f]{64}$/.test(line)),
	);
}

async function listStaging(home: string): Promise<string[]> {
	const result = await runRemoteCommand(credentialsOrThrow(), "ls -d " + deployRootOf(home) + "/.staging-* " + deployRootOf(home) + "/.staging-ext-* 2>/dev/null || true", 30_000);
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * 部署锁与 bootstrap 进程：取消之后必须一个都不剩。
 *
 * 进程判据是 `comm == node` 且 argv 含入口 token——不能用 `pgrep -f`：探测命令自己的 shell 命令行里
 * 也带着这个字符串，那种写法永远数到 1，看起来像「取消后还留着进程」。
 */
async function deploymentLeftovers(home: string): Promise<{ locks: string[]; processes: number }> {
	const result = await runRemoteCommand(credentialsOrThrow(), "ls -d " + deployRootOf(home) + "/.deploy*.lock 2>/dev/null || true; ps -eo comm=,args= | awk '$1 ~ /^node/ && /pideck-bootstrap-inline-v1/ {c++} END {print c+0}'", 30_000);
	const lines = result.stdout.split("\n").map((line) => line.trim());
	const processes = Number(lines.filter((line) => /^\d+$/.test(line)).at(-1) ?? "0");
	return { locks: lines.filter((line) => line.length > 0 && line.includes(".deploy")), processes };
}

/** 轮询一个远端事实，直到成立或超时；用于「staging 已出现/已清掉」这类进程边界信号。 */
async function waitForRemote(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("timed out waiting for " + label);
}

type ConnectResult = { ok: boolean; state?: string; code?: string };

/** 在渲染进程里发起一次 connect 并**不等待**它：取消要发生在它还在跑的时候。 */
async function startConnectInBackground(window: Page, hostId: string): Promise<void> {
	await window.evaluate((id: string) => {
		const holder = window as unknown as {
			piDesktop: { remoteHosts: { connect: (hostId: string) => Promise<unknown> } };
			__pideckE2eConnect?: Promise<unknown>;
			__pideckE2eConnectResult?: unknown;
		};
		holder.__pideckE2eConnectResult = undefined;
		holder.__pideckE2eConnect = holder.piDesktop.remoteHosts.connect(id).then((result) => {
			holder.__pideckE2eConnectResult = result;
			return result;
		});
	}, hostId);
}

/** 读取后台 connect 的最终返回（超时返回 null）。 */
async function readBackgroundConnect(window: Page): Promise<ConnectResult | null> {
	return (await window.evaluate(async () => {
		const holder = window as unknown as { __pideckE2eConnectResult?: unknown };
		for (let index = 0; index < 600 && holder.__pideckE2eConnectResult === undefined; index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
		return holder.__pideckE2eConnectResult ?? null;
	})) as ConnectResult | null;
}

/** 主进程 connect 的返回形状：取消后必须是 SSH_HOST_DISCONNECTED，而不是一个笼统的失败。 */
function connectOutcome(result: ConnectResult | null): string {
	if (result === null) return "<no result>";
	if (result.ok) return "ready";
	return String(result.code ?? "");
}

test.describe("远端功能优化 F1–F4（真机）", () => {
	test.skip(credentials === undefined, HELP_TEXT);

	test("部署中取消 → 立即重试 → 复用命中 → 1500 条会话整表扫描", async ({ remoteWindow }) => {
		test.setTimeout(900_000);
		const creds = credentialsOrThrow();
		const window = remoteWindow;
		const runId = "f" + Date.now().toString(36);
		const home = (await runRemoteCommand(creds, 'printf %s "$HOME"', 30_000)).stdout.trim();
		expect(home.startsWith("/"), "远端 $HOME 必须是绝对 POSIX 路径").toBe(true);
		expect(/\s/.test(home), "远端 $HOME 含空白：夹具与清理脚本不做引用").toBe(false);
		const sessionsRoot = home + "/.pi/agent/sessions";
		// 本 run 独有的 workspace 目录：夹具与清理都只碰它。
		const workspaceDir = "e2e-f4-" + runId;
		const fixtureDir = sessionsRoot + "/" + workspaceDir;
		// 夹具文件名与扫描结果里的 relative id 必须逐字一致，所以只有这一处生成前缀。
		const fixturePrefix = "e2e-f4-" + runId + "-";
		const fixtureStem = (index: number) => fixturePrefix + String(index).padStart(4, "0");
		const heldBundle = deployRootOf(home) + "/bundles/" + OUR_BUNDLE + ".e2e-" + runId;
		let hostId: string | undefined;
		let heldAside = false;
		console.log("[remote-functional] run=" + runId + " host=" + creds.host + " user=" + creds.user + " bundle=" + OUR_BUNDLE.slice(0, 12));

		try {
			await test.step("远端前置：" + FIXTURE_SESSIONS + " 条会话夹具（本 run 独有目录，结束清理）", async () => {
				// 一条 shell 内的循环：内容与文件名用同一个序号，避免 1500 次进程创建。
				const script = ["set -e", "mkdir -p " + fixtureDir, "i=1; while [ $i -le " + FIXTURE_SESSIONS + ' ]; do printf \'{"type":"session_info","name":"E2E F4 ' + runId + " %04d\"}\\n' $i > " + fixtureDir + "/" + fixturePrefix + "$(printf %04d $i).jsonl; i=$((i+1)); done", "ls " + fixtureDir + " | wc -l"].join(" && ");
				const result = await runRemoteCommand(creds, script, 180_000);
				expect(Number(result.stdout.trim()), "夹具条数必须是 " + FIXTURE_SESSIONS).toBe(FIXTURE_SESSIONS);
			});

			await test.step("加主机（产品 IPC：首次信任在主进程内完成）", async () => {
				const added = (await window.evaluate(
					async (input) => {
						const api = (window as unknown as { piDesktop: { remoteHosts: { add: (value: unknown) => Promise<unknown> } } }).piDesktop;
						return api.remoteHosts.add(input);
					},
					{ label: "serve", hostName: creds.host, user: creds.user, port: creds.port },
				)) as { ok: boolean; hostId?: string; code?: string };
				expect(added.ok, "add must succeed: " + String(added.code)).toBe(true);
				hostId = added.hostId;
				expect(typeof hostId, "add must return the host id").toBe("string");
			});

			await test.step("让第一次连接成为冷部署：把本版本 bundle 暂时移开（无活跃 lease 才动）", async () => {
				const leases = await runRemoteCommand(creds, "ls " + deployRootOf(home) + "/leases 2>/dev/null | wc -l", 30_000);
				expect(Number(leases.stdout.trim()), "有活跃 lease 时不得移动任何 bundle").toBe(0);
				if ((await listBundles(home)).includes(OUR_BUNDLE)) {
					await runRemoteCommand(creds, "mv " + deployRootOf(home) + "/bundles/" + OUR_BUNDLE + " " + heldBundle, 30_000);
					heldAside = true;
				}
				expect(await listBundles(home), "本版本 bundle 必须不在原位，连接才是冷部署").not.toContain(OUR_BUNDLE);
			});

			await test.step("F1：冷部署中取消 → connect 返回已断开，且本 run 不留下任何部署痕迹", async () => {
				if (hostId === undefined) throw new Error("host id must be known before connecting");
				const target = hostId;
				// 不等待 connect：它会把整段 bootstrap 跑完；远端 staging 出现即「已进入部署」的边界信号。
				await startConnectInBackground(window, target);
				await waitForRemote(async () => (await listStaging(home)).length > 0, 60_000, "the deploy staging directory");
				// 此刻入口已拿到部署锁、staging 已建：取消必须立即收敛，而不是等上传/finalize 预算走完。
				const cancelStarted = Date.now();
				const disconnected = (await window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { disconnect: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.disconnect(id);
				}, target)) as { ok: boolean; code?: string };
				expect(disconnected.ok, "disconnect must succeed: " + String(disconnected.code)).toBe(true);
				const connectResult = await readBackgroundConnect(window);
				const cancelMs = Date.now() - cancelStarted;
				expect(connectOutcome(connectResult), "the cancelled attempt must settle as SSH_HOST_DISCONNECTED: " + JSON.stringify(connectResult)).toBe("SSH_HOST_DISCONNECTED");
				expect(cancelMs, "cancel must converge far below the 300s session budget").toBeLessThan(20_000);
				console.log("[remote-functional] F1 cancelMs=" + cancelMs);
				// 提交点之前取消：bundle 仍未激活，staging/锁/进程都要清干净。
				expect(await listBundles(home), "a cancelled deploy must not activate this bundle").not.toContain(OUR_BUNDLE);
				await waitForRemote(async () => (await listStaging(home)).length === 0, 15_000, "staging cleanup after cancel");
				// 远端进程退出可能比 ssh 关闭晚一瞬：给一个有界的收敛窗口，而不是采样一次就当结论。
				let leftovers = await deploymentLeftovers(home);
				await waitForRemote(
					async () => {
						leftovers = await deploymentLeftovers(home);
						return leftovers.locks.length === 0 && leftovers.processes === 0;
					},
					10_000,
					"deploy lock and bootstrap process cleanup",
				);
				expect(leftovers.locks, "a cancelled deploy must not leave the deploy lock").toEqual([]);
				expect(leftovers.processes, "a cancelled deploy must not leave the bootstrap entry running").toBe(0);
			});

			await test.step("F1：立即重试完成一次真实冷部署", async () => {
				if (hostId === undefined) throw new Error("host id must be known before retrying");
				const target = hostId;
				const retried = (await window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { connect: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.connect(id);
				}, target)) as ConnectResult;
				expect(retried.ok, "the retry must connect: " + String(retried.code)).toBe(true);
				expect(retried.state).toBe("ready");
				expect(await listBundles(home), "the retry must activate this bundle").toContain(OUR_BUNDLE);
				expect(await listStaging(home), "a successful deploy must not leave staging").toEqual([]);
			});

			await test.step("F3：断开 → 再连接命中复用检查（bundle 集合不变、无新上传）", async () => {
				if (hostId === undefined) throw new Error("host id must be known before reconnecting");
				const target = hostId;
				const coldBundles = await listBundles(home);
				const disconnected = (await window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { disconnect: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.disconnect(id);
				}, target)) as { ok: boolean };
				expect(disconnected.ok, "disconnect before the reuse check must succeed").toBe(true);
				const warmStarted = Date.now();
				const rewired = (await window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteHosts: { connect: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteHosts.connect(id);
				}, target)) as ConnectResult;
				const warmMs = Date.now() - warmStarted;
				expect(rewired.ok, "the reconnect must succeed: " + String(rewired.code)).toBe(true);
				expect(rewired.state).toBe("ready");
				expect(await listStaging(home), "a reuse hit must not leave staging").toEqual([]);
				expect(unique(await listBundles(home)), "a reuse hit must not add a bundle (a new sha means another upload)").toEqual(unique(coldBundles));
				console.log("[remote-functional] F3 warmMs=" + warmMs + " bundles=" + coldBundles.length);
			});

			await test.step("F4：整表扫描包含全部 " + FIXTURE_SESSIONS + " 条真机会话", async () => {
				if (hostId === undefined) throw new Error("host id must be known before scanning");
				const target = hostId;
				const started = Date.now();
				const scan = (await window.evaluate(async (id: string) => {
					const api = (window as unknown as { piDesktop: { remoteSessions: { scan: (hostId: string) => Promise<unknown> } } }).piDesktop;
					return api.remoteSessions.scan(id);
				}, target)) as { ok: boolean; code?: string; entries?: Array<{ remoteSessionId: string }> };
				const elapsed = Date.now() - started;
				expect(scan.ok, "scan must succeed: " + String(scan.code)).toBe(true);
				const ids = new Set((scan.entries ?? []).map((entry) => entry.remoteSessionId));
				const missing: string[] = [];
				for (let index = 1; index <= FIXTURE_SESSIONS; index += 1) {
					const id = workspaceDir + "/" + fixtureStem(index) + ".jsonl";
					if (ids.has(id) === false) missing.push(id);
				}
				expect(missing.slice(0, 5), "every fixture session must be listed (" + missing.length + " missing)").toEqual([]);
				console.log("[remote-functional] F4 scanMs=" + elapsed + " entries=" + ids.size);
				expect(elapsed, "the whole listing must finish within 30s").toBeLessThan(30_000);
				expect(timeouts.helperMs, "the helper budget must stay the acceptance one").toBeGreaterThan(0);
			});
		} finally {
			// 只清理本 run 的夹具与临时移开的副本；不碰用户会话、其它 bundle、配置或安全策略。
			if (hostId !== undefined) {
				await window
					.evaluate(async (id: string) => {
						const api = (window as unknown as { piDesktop: { remoteHosts: { disconnect: (hostId: string) => Promise<unknown> } } }).piDesktop;
						return api.remoteHosts.disconnect(id);
					}, hostId)
					.catch(() => undefined);
			}
			await runRemoteCommand(credentialsOrThrow(), "rm -rf " + fixtureDir + (heldAside ? " " + heldBundle : ""), 60_000).catch(() => undefined);
		}
	});
});
