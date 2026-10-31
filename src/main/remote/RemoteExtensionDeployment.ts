/**
 * 远端内置扩展快照部署（P4.4 扩展面，`docs/remote-extension-injection-plan.md` D1）。
 *
 * 为什么单独一个模块、而不是塞进 `RemoteBootstrapDeployment`：两者**共用**同一套已审计的
 * staging/锁/逐文件 sha256/强制 mode/原子 rename 提交逻辑（那个入口现在带一个 target），
 * 但生命周期不同——helper/runner 是「本版本要跑的控制面代码」，扩展快照是「本机生效的业务代码」，
 * 更新频率差一个数量级。共用部署逻辑、分开调用点，才能既复用不变量又各自清理。
 *
 * 本模块不决定「注入哪些扩展」（那是 `remoteExtensionSnapshot` + settings 的事），只负责
 * 「把这份快照按内容寻址放到远端，并返回可拼进 `-e` 的根路径」。
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";
import { REMOTE_BOOTSTRAP_PROTOCOL_VERSION } from "./RemoteHelperContract";
import { buildBundleManifest, type BundleFileObservation } from "./RemoteBootstrapUpload";
import { deployPreparedBundle, type PreparedBundleResult } from "./RemoteBootstrapDeployment";
import { runPreparedBootstrap } from "./RemoteBootstrapSession";
import type { BootstrapReadyFrame, BootstrapSession } from "./RemoteBootstrapTransfer";

/** 一个待部署的扩展快照：目录 + 要上传的文件名（来自整份校验通过的清单）。 */
export type RemoteExtensionSnapshotInput = {
	readonly dir: string;
	readonly names: readonly string[];
};

export type RemoteExtensionDeploymentInput = {
	readonly userDataDir: string;
	readonly hostId: string;
	readonly generation: number;
	readonly nonce: string;
	readonly nodePath: string;
	readonly client: SshClientRuntime;
	readonly launcher: SshProcessLauncher;
	readonly snapshot: RemoteExtensionSnapshotInput;
	/** Cancels this deployment attempt (same semantics as the helper bootstrap). */
	readonly signal?: AbortSignal;
};

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** 与 bootstrap 清单同一形态：单段、非隐藏、无分隔符。 */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalid(): never {
	throw new Error("BOOTSTRAP_INPUT_INVALID");
}

/** 读快照文件并算出**远端将要激活的同一个**内容地址（上传前的本地观测）。 */
async function observeSnapshot(snapshot: RemoteExtensionSnapshotInput): Promise<BundleFileObservation[]> {
	if (typeof snapshot?.dir !== "string" || !isAbsolute(snapshot.dir) || !Array.isArray(snapshot.names) || snapshot.names.length === 0) invalid();
	const seen = new Set<string>();
	const observations: BundleFileObservation[] = [];
	for (const name of snapshot.names) {
		if (typeof name !== "string" || !FILE_NAME.test(name) || seen.has(name)) invalid();
		seen.add(name);
		let bytes: Buffer;
		try {
			bytes = await readFile(join(snapshot.dir, name));
		} catch {
			// 本机生效快照已由 readVerifiedArtifact 校验过；读不到只可能是部署途中被外部改动，
			// 这时不能上传半份快照，按内容不匹配拒绝（远端也不会激活未声明字节）。
			throw new Error("BUNDLE_FILE_MISMATCH");
		}
		observations.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	return observations;
}

/** 写一份私有临时目录供上传用；与 helper 部署同款 0o400 快照语义。 */
async function stageSnapshotFiles(snapshot: RemoteExtensionSnapshotInput): Promise<{ directory: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pideck-extension-snapshot-"));
	try {
		for (const name of snapshot.names) {
			const bytes = await readFile(join(snapshot.dir, name));
			await writeFile(join(directory, name), bytes, { flag: "wx", mode: 0o400 });
		}
		return { directory };
	} catch (error) {
		await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
		throw error;
	}
}

/** 上传 + finalize；只允许 target=extensions，避免调用方拿错目录写进去。 */
async function deployStagedExtensionSnapshot(input: {
	connection: Parameters<typeof deployPreparedBundle>[0]["connection"];
	ready: BootstrapReadyFrame;
	launcher: SshProcessLauncher;
	session: BootstrapSession;
	hostId: string;
	generation: number;
	snapshot: RemoteExtensionSnapshotInput;
	signal?: AbortSignal;
}): Promise<PreparedBundleResult> {
	const staged = await stageSnapshotFiles(input.snapshot);
	try {
		return await deployPreparedBundle({
			connection: input.connection,
			ready: input.ready,
			launcher: input.launcher,
			session: input.session,
			hostId: input.hostId,
			generation: input.generation,
			target: "extensions",
			directory: staged.directory,
			names: [...input.snapshot.names],
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
	} finally {
		await rm(staged.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
	}
}

/**
 * 部署一份扩展快照，返回确认激活的内容地址（`deployRoot` + `active`）。
 *
 * 失败语义与 helper 部署一致：任何一步失败都抛稳定码，已上传的 staging 由 entry 自己清理
 * （abort/EOF 路径），这里不重试、不写第二次。
 */
export async function deployRemoteExtensionSnapshot(input: RemoteExtensionDeploymentInput): Promise<PreparedBundleResult> {
	if (!HOST_ID.test(input?.hostId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || !NONCE.test(input.nonce) || typeof input.launcher?.start !== "function") invalid();
	const observations = await observeSnapshot(input.snapshot);
	const manifest = buildBundleManifest(observations);
	if (!SHA256.test(manifest.bundleSha256)) invalid();
	const sshConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", {
		client: input.client,
		bootstrap: { nodeExecutable: input.nodePath, protocolVersion: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, bundleSha256: manifest.bundleSha256, nonce: input.nonce, target: "extensions" },
	});
	const scpConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "scp", { client: input.client });
	return await runPreparedBootstrap({
		hostId: input.hostId,
		generation: input.generation,
		nonce: input.nonce,
		expectedBundleSha256: manifest.bundleSha256,
		target: "extensions",
		sshConnection,
		scpConnection,
		launcher: input.launcher,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		deploy: (session, ready) => deployStagedExtensionSnapshot({ connection: scpConnection, ready, launcher: input.launcher, session, hostId: input.hostId, generation: input.generation, snapshot: input.snapshot, ...(input.signal === undefined ? {} : { signal: input.signal }) }),
	});
}

/** 已部署扩展快照的绝对 POSIX 根目录（`-e` 的父路径）；只从部署结果推导，不接受调用方拼。 */
export function deployedExtensionSnapshotRoot(result: PreparedBundleResult): string {
	if (typeof result !== "object" || result === null) invalid();
	const active = /^\.\/extensions\/([0-9a-f]{64})$/.exec(typeof result.active === "string" ? result.active : "");
	if (active === null || active[1] !== result.bundleSha256) invalid();
	if (typeof result.deployRoot !== "string" || !result.deployRoot.startsWith("/") || result.deployRoot.endsWith("/") || /[\u0000-\u001f\u007f]/.test(result.deployRoot)) invalid();
	return `${result.deployRoot}/extensions/${active[1]}`;
}
