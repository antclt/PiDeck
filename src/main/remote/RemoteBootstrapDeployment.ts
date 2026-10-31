import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { bootstrapTargetLayout, type RemoteBootstrapTarget } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME, type RemoteBundleManifest } from "./RemoteHelperContract";
import { runBootstrapFinalize, runBootstrapVerify, type BootstrapSession } from "./RemoteBootstrapTransfer";
import { buildBundleManifest, withPrivateBundleUploadPlan, type BundleUploadInput } from "./RemoteBootstrapUpload";
import { REMOTE_HELPER_ARTIFACTS, REMOTE_HELPER_ENTRY_FILE_NAME } from "./RemoteHelperEntry";
import { isRemoteRunnerAbsolutePath, REMOTE_RUNNER_CODE_INPUT_INVALID } from "./RemoteRunnerContract";
import { REMOTE_RUNNER_ENTRY_FILE_NAME, REMOTE_RUNNER_ENTRY_SHA256, REMOTE_RUNNER_INLINE_SOURCE } from "./RemoteRunnerEntry";
import { REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME } from "./RemoteTerminalRunnerEntry";
import type { SshProcessExit, SshProcessLauncher } from "./RemoteHostConnectionTypes";

/** Cancellation of one deployment attempt: the same stable code the bootstrap session uses. */
export const REMOTE_BOOTSTRAP_ABORTED = "BOOTSTRAP_ABORTED";

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error(REMOTE_BOOTSTRAP_ABORTED);
}

/** One ready staging entry and one freshly preflighted scp invocation. The caller owns the entry session. */
export type PreparedBundleDeployment = BundleUploadInput & {
	hostId: string;
	generation: number;
	launcher: SshProcessLauncher;
	session: BootstrapSession;
	/** Cancels the upload/finalize wait; the entry session itself is stopped by its owner. */
	signal?: AbortSignal;
};

/**
 * One confirmed activation, as the remote entry reported it.
 *
 * `deployRoot` is the absolute POSIX `<home>/.pideck/remote-host` the entry resolved from its own HOME, and
 * `active` is the activated bundle directory *relative to that root*, spelled the way the entry reports it
 * (`./bundles/<bundleSha256>`) — never absolute, so a caller cannot mistake it for a deploy root. Both are
 * inputs to `resolveHelperEntryPath`/`deployedRunnerPath`, which is where they turn into a remote path.
 */
export type PreparedBundleResult = { bundleSha256: string; deployRoot: string; active: string /** True when the frozen entry re-proved the already active bundle and nothing was transferred. */; reused?: boolean };

/**
 * Compute the audited bundle identity before starting the bootstrap entry, so ready can be verified. Both
 * frozen entries are part of it: the helper the control connection speaks to and the runner that supervises
 * one remote pi. They are deployed as one immutable, content-addressed directory (§168), so a client can
 * never end up with the helper of one build and the runner of another.
 */
export function frozenHelperBundleManifest(): RemoteBundleManifest {
	return buildBundleManifest([...REMOTE_HELPER_ARTIFACTS.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, bytes: Buffer.byteLength(artifact.source, "utf8") })), { name: REMOTE_RUNNER_ENTRY_FILE_NAME, sha256: REMOTE_RUNNER_ENTRY_SHA256, bytes: Buffer.byteLength(REMOTE_RUNNER_INLINE_SOURCE, "utf8") }]);
}

/** Prepare only frozen helper code; the deployment retains and clears both the source and upload snapshot. */
export async function deployFrozenHelperBundle(input: Omit<PreparedBundleDeployment, "directory" | "names" | "executableNames" | "target">): Promise<PreparedBundleResult> {
	const directory = await mkdtemp(join(tmpdir(), "pideck-frozen-helper-"));
	try {
		// Every reviewed artifact is written and hashed on its own: the entry, the Git worker it imports and the write
		// programs that worker imports. The remote entry verifies each file's pinned digest before it activates.
		for (const artifact of REMOTE_HELPER_ARTIFACTS) await writeFile(join(directory, artifact.name), artifact.source, { flag: "wx", mode: 0o400 });
		await writeFile(join(directory, REMOTE_RUNNER_ENTRY_FILE_NAME), REMOTE_RUNNER_INLINE_SOURCE, { flag: "wx", mode: 0o400 });
		return await deployPreparedBundle({ ...input, target: "helper", directory, names: [...REMOTE_HELPER_ARTIFACTS.map((artifact) => artifact.name), REMOTE_RUNNER_ENTRY_FILE_NAME] });
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCP_TIMEOUT_MS = 120_000;
const FINALIZE_TIMEOUT_MS = 120_000;
/** The activated directory exactly as the frozen entry reports it (the staging name never appears). */
function activeBundlePattern(target: RemoteBootstrapTarget): RegExp {
	return new RegExp(`^\\./${bootstrapTargetLayout(target).directory}/([0-9a-f]{64})$`);
}

/**
 * Absolute remote path of the runner inside one confirmed activation — the `runnerPath` of a remote launch
 * plan, and the only way main is allowed to name the artifact.
 *
 * Both inputs are the remote's own words: `deployRoot` is the absolute POSIX root the entry resolved from its
 * HOME, `active` the relative bundle directory it activated. They are re-checked here rather than trusted,
 * because a wrong path here starts a program instead of failing: a relative `active`, a bundle the entry
 * never activated for this hash, or a deploy root that is not an absolute POSIX path all refuse. The
 * assembled path is then checked against the pinned ssh command ceiling by `buildRemoteRunnerCommand`, which
 * is the last gate before the bytes leave this process.
 */
export function deployedRunnerPath(result: PreparedBundleResult): string {
	if (typeof result !== "object" || result === null) throw new Error(REMOTE_RUNNER_CODE_INPUT_INVALID);
	const active = activeBundlePattern("helper").exec(typeof result.active === "string" ? result.active : "");
	if (active === null || active[1] !== result.bundleSha256) throw new Error(REMOTE_RUNNER_CODE_INPUT_INVALID);
	if (!isRemoteRunnerAbsolutePath(result.deployRoot)) throw new Error(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return `${result.deployRoot}/${REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME}/${active[1]}/${REMOTE_RUNNER_ENTRY_FILE_NAME}`;
}

/**
 * Absolute remote path of the frozen terminal runner inside one confirmed activation. Same re-checks as
 * `deployedRunnerPath` (the deployed words for the root and the content address, not caller text), because this
 * path is started with `ssh -tt`: a wrong one would run a program instead of failing.
 */
export function deployedTerminalRunnerPath(input: { deployRoot: string; bundleSha256: string }): string {
	if (typeof input !== "object" || input === null) throw new Error(REMOTE_RUNNER_CODE_INPUT_INVALID);
	if (typeof input.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.bundleSha256) || !isRemoteRunnerAbsolutePath(input.deployRoot)) throw new Error(REMOTE_RUNNER_CODE_INPUT_INVALID);
	return `${input.deployRoot}/${REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME}/${input.bundleSha256}/${REMOTE_TERMINAL_RUNNER_ENTRY_FILE_NAME}`;
}

/** Subscribe before observing process exit; the production launcher replays an already-settled exit. */
async function awaitUploadExit(launcher: SshProcessLauncher, input: PreparedBundleDeployment, invocation: BundleUploadInput["connection"]): Promise<SshProcessExit> {
	const handle = await launcher.start({ hostId: input.hostId, generation: input.generation, invocation, timeoutMs: SCP_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
	let observed = false;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<SshProcessExit>((resolve) => {
			let unsubscribe: (() => void) | undefined;
			onAbort = (): void => {
				// Terminate only this upload's own process; the exit report then settles the wait below.
				void handle.stop("abort").catch(() => undefined);
			};
			const finish = (exit: SshProcessExit): void => {
				if (observed) return;
				observed = true;
				input.signal?.removeEventListener("abort", onAbort as () => void);
				unsubscribe?.();
				resolve(exit);
			};
			// Register first, then read the signal: an abort that landed while start() was spawning must
			// still terminate this process and never leave the wait suspended.
			input.signal?.addEventListener("abort", onAbort, { once: true });
			if (input.signal?.aborted === true) onAbort();
			unsubscribe = handle.onExit(finish);
			if (observed) unsubscribe();
		});
	} finally {
		if (onAbort !== undefined) input.signal?.removeEventListener("abort", onAbort);
		if (!observed) await handle.stop("abort").catch(() => undefined);
	}
}

/** Transfer from the validated snapshot; only exit 0 permits finalize on the existing entry session. */
export async function deployPreparedBundle(input: PreparedBundleDeployment): Promise<PreparedBundleResult> {
	if (!HOST_ID.test(input?.hostId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || typeof input.launcher?.start !== "function" || typeof input.session?.write !== "function" || typeof input.session?.onStdoutLine !== "function" || !isAbsolute(input.connection?.executable ?? ""))
		throw new Error("BOOTSTRAP_INPUT_INVALID");
	let finalized = false;
	try {
		throwIfAborted(input.signal);
		return await withPrivateBundleUploadPlan(input, async (plan) => {
			throwIfAborted(input.signal);
			// Reuse first (F3): the frozen entry re-proves the already active content-addressed directory
			// against this manifest. A verified answer means no upload at all; an installed but different
			// directory is a conflict and must never be silently replaced or "repaired" by a fresh upload.
			const verdict = await runBootstrapVerify(input.session, plan.manifest, { executableNames: plan.executableNames, target: input.target, timeoutMs: FINALIZE_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) });
			throwIfAborted(input.signal);
			if (verdict.status === "verified") {
				finalized = true;
				return { bundleSha256: plan.manifest.bundleSha256, deployRoot: input.ready.deployRoot, active: verdict.active, reused: true };
			}
			if (verdict.status === "conflict") throw new Error("BOOTSTRAP_ACTIVE_CONFLICT");
			if (verdict.status === "timeout") throw new Error("BOOTSTRAP_FINALIZE_UNCONFIRMED");
			if (verdict.status === "error") throw new Error(verdict.code === "BOOTSTRAP_ACTIVE_CONFLICT" || verdict.code === "BOOTSTRAP_FINALIZE_UNCONFIRMED" ? verdict.code : "BOOTSTRAP_REMOTE_REJECTED");
			if (verdict.status !== "absent") throw new Error(REMOTE_BOOTSTRAP_ABORTED);
			const invocation = { ...input.connection, executable: plan.invocation.executable, args: plan.invocation.args, env: plan.invocation.env, cwd: plan.invocation.cwd };
			const exit = await awaitUploadExit(input.launcher, input, invocation);
			// A cancel during the transfer terminates the upload process; no finalize may follow it.
			throwIfAborted(input.signal);
			if (exit.kind !== "exited" || exit.code !== 0) throw new Error("BOOTSTRAP_UPLOAD_FAILED");
			throwIfAborted(input.signal);
			const outcome = await runBootstrapFinalize(input.session, plan.manifest, { executableNames: plan.executableNames, target: input.target, timeoutMs: FINALIZE_TIMEOUT_MS, ...(input.signal === undefined ? {} : { signal: input.signal }) });
			if (outcome.status === "timeout" || (outcome.status === "error" && outcome.code === "BOOTSTRAP_FINALIZE_UNCONFIRMED")) throw new Error("BOOTSTRAP_FINALIZE_UNCONFIRMED");
			if (outcome.status !== "finalized") throw new Error(outcome.status === "aborted" ? REMOTE_BOOTSTRAP_ABORTED : "BOOTSTRAP_REMOTE_REJECTED");
			finalized = true;
			return { bundleSha256: plan.manifest.bundleSha256, deployRoot: input.ready.deployRoot, active: outcome.active };
		});
	} catch (error) {
		// Before confirmed activation, ask the entry to remove its staging and release the deploy lock.
		// After a timeout the rename may already have happened: abort is not claimed as a rollback.
		if (!finalized) {
			try {
				input.session.write('{"v":1,"op":"abort"}');
			} catch {
				// Session loss also closes the remote entry's stdin, which makes it clean up staging.
			}
		}
		throw error;
	}
}
