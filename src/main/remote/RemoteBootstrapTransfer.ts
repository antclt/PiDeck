import { bootstrapTargetLayout, decodeBundleManifest, type RemoteBootstrapTarget } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, REMOTE_BOOTSTRAP_PROTOCOL_VERSION, type RemoteBootstrapFileMode, type RemoteBootstrapInboundFrame, type RemoteBundleManifest } from "./RemoteHelperContract";

/** A bootstrap staging session: frames out through write(), results in through stdout and process exit. */
export type BootstrapSession = {
	write(line: string): void;
	onStdoutLine(listener: (line: string) => void): () => void;
	onExit(listener: () => void): () => void;
};

export type BootstrapTimers = {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type BootstrapFinalizeOutcome = { status: "finalized"; active: string; files: number } | { status: "aborted"; reason: "requested" | "eof" } | { status: "error"; code: string } | { status: "timeout" };

/** Validated `ready` payload: the upload step needs these values to place the bundle. */
export type BootstrapReadyFrame = { op: "ready"; protocolVersion: number; bundleSha256: string; nonce: string; deployRoot: string; staging: string };

export type BootstrapFinalizeOptions = {
	/** Files that must land mode 0700; everything else is uploaded as 0600. */
	executableNames?: readonly string[];
	/** Closed deploy target: the value the entry echoes back in `finalized.active` is bound to it. */
	target?: RemoteBootstrapTarget;
	timeoutMs?: number;
	timers?: BootstrapTimers;
	/**
	 * Cancellation of the finalize wait. Before the commit frame is issued it ends as `aborted` (nothing was
	 * committed); after it, the commit may already have happened, so the only truthful report is
	 * `BOOTSTRAP_FINALIZE_UNCONFIRMED` - a cancel can never be claimed as a rollback.
	 */
	signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const ACTIVE = /^\.\/([A-Za-z0-9._-]{1,32})\/([0-9a-f]{64})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never {
	throw new Error("BOOTSTRAP_INPUT_INVALID");
}

function onlyKeys(frame: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(frame);
	return own.length === keys.length && own.every((key) => keys.includes(key));
}

/**
 * Map an arbitrary thrown value to a stable code. Duck-typed rather than `instanceof Error` because
 * errors can cross realm boundaries, and whitelisted so a transport error carrying a path or frame
 * text can never surface as this function's message.
 */
function toStableError(error: unknown): Error {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return new Error(typeof message === "string" && CODE.test(message) ? message : "BOOTSTRAP_INPUT_INVALID");
}

function modeFor(name: string, executableNames: readonly string[]): RemoteBootstrapFileMode {
	return executableNames.includes(name) ? "0700" : "0600";
}

/**
 * Build the ordered inbound frames for one finalize run. The entry caps a line at 4096 bytes, so the
 * manifest travels per file; a frame that would exceed the cap is refused here rather than truncated
 * by the remote side. Frames are returned without the trailing newline the transport appends.
 */
export function buildFinalizeFrames(manifest: RemoteBundleManifest, options: { executableNames?: readonly string[] } = {}): string[] {
	return buildDeclarationFrames(manifest, options, "finalize-commit");
}

/**
 * Frames of one read-only reuse check: the same declaration plus `finalize-verify` instead of the commit.
 * The entry answers `verified` (nothing to transfer), `verify-miss` (absent or conflict) or an error.
 */
export function buildVerifyFrames(manifest: RemoteBundleManifest, options: { executableNames?: readonly string[] } = {}): string[] {
	return buildDeclarationFrames(manifest, options, "finalize-verify");
}

function buildDeclarationFrames(manifest: RemoteBundleManifest, options: { executableNames?: readonly string[] }, terminator: "finalize-commit" | "finalize-verify"): string[] {
	// Decoding first proves the manifest is well-formed before anything is put on the wire.
	const decoded = decodeBundleManifest(manifest);
	const executableNames = options.executableNames ?? [];
	if (!Array.isArray(executableNames) || executableNames.some((name) => typeof name !== "string")) invalid();
	// The same rule the manifest-side contract applies: an unknown or repeated name would silently
	// downgrade the entry point to 0600, which only fails much later at exec time.
	const declaredNames = new Set(decoded.files.map((file) => file.name));
	if (new Set(executableNames).size !== executableNames.length || executableNames.some((name) => !declaredNames.has(name))) invalid();
	const frames: RemoteBootstrapInboundFrame[] = [{ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: "finalize-begin", files: decoded.files.length, bundleSha256: decoded.bundleSha256 }];
	for (const file of decoded.files) {
		frames.push({ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: "finalize-file", name: file.name, sha256: file.sha256, bytes: file.bytes, mode: modeFor(file.name, executableNames) });
	}
	frames.push({ v: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, op: terminator } as RemoteBootstrapInboundFrame);
	return frames.map((frame) => {
		const line = JSON.stringify(frame);
		if (Buffer.byteLength(line, "utf8") > REMOTE_BOOTSTRAP_MAX_FRAME_BYTES) throw new Error("BOOTSTRAP_INPUT_INVALID");
		return line;
	});
}

/** Strictly decode one result frame; unknown or malformed lines return null so they can be ignored. */
export function decodeBootstrapResult(
	line: string,
	target: RemoteBootstrapTarget = "helper",
): BootstrapReadyFrame | { op: "finalized"; active: string; files: number } | { op: "verified"; active: string; files: number } | { op: "verify-miss"; reason: "absent" | "conflict" } | { op: "aborted"; reason: "requested" | "eof" } | { op: "error"; code: string } | null {
	const layout = bootstrapTargetLayout(target);
	if (typeof line !== "string" || line.length === 0) return null;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const frame = value as Record<string, unknown>;
	if (frame.v !== REMOTE_BOOTSTRAP_PROTOCOL_VERSION || typeof frame.op !== "string") return null;
	if (frame.op === "ready") {
		// The upload step is told where to put the bytes, so this payload is validated instead of dropped.
		if (!onlyKeys(frame, ["v", "op", "protocolVersion", "bundleSha256", "nonce", "deployRoot", "staging", "stagingMode"])) return null;
		if (frame.protocolVersion !== REMOTE_BOOTSTRAP_PROTOCOL_VERSION || frame.stagingMode !== "0700") return null;
		if (typeof frame.bundleSha256 !== "string" || !SHA256.test(frame.bundleSha256)) return null;
		if (typeof frame.nonce !== "string" || !NONCE.test(frame.nonce)) return null;
		if (typeof frame.deployRoot !== "string" || !frame.deployRoot.startsWith("/") || frame.deployRoot.length > 4096 || CONTROL.test(frame.deployRoot)) return null;
		if (frame.staging !== `${layout.stagingPrefix}${frame.nonce}`) return null;
		return { op: "ready", protocolVersion: frame.protocolVersion, bundleSha256: frame.bundleSha256, nonce: frame.nonce, deployRoot: frame.deployRoot, staging: frame.staging };
	}
	if (frame.op === "error") {
		if (!onlyKeys(frame, ["v", "op", "code"])) return null;
		return typeof frame.code === "string" && CODE.test(frame.code) ? { op: "error", code: frame.code } : null;
	}
	if (frame.op === "aborted") {
		if (!onlyKeys(frame, ["v", "op", "reason"])) return null;
		return frame.reason === "requested" || frame.reason === "eof" ? { op: "aborted", reason: frame.reason } : null;
	}
	if (frame.op === "verify-miss") {
		if (!onlyKeys(frame, ["v", "op", "reason"])) return null;
		return frame.reason === "absent" || frame.reason === "conflict" ? { op: "verify-miss", reason: frame.reason } : null;
	}
	if (frame.op === "verified") {
		// Same binding as a finalize receipt: the remote may only name the directory this target owns for
		// the manifest hash main declared, and the file count must match that declaration.
		if (!onlyKeys(frame, ["v", "op", "active", "files"])) return null;
		if (typeof frame.active !== "string" || !ACTIVE.test(frame.active) || !frame.active.startsWith(`./${layout.directory}/`)) return null;
		if (typeof frame.files !== "number" || !Number.isSafeInteger(frame.files) || frame.files < 0) return null;
		return { op: "verified", active: frame.active, files: frame.files };
	}
	if (frame.op === "finalized") {
		// The active path is bound to the pinned content-addressed shape; a free-form string from the
		// remote must never become the path PiDeck records or later execs.
		if (!onlyKeys(frame, ["v", "op", "active", "files"])) return null;
		if (typeof frame.active !== "string" || !ACTIVE.test(frame.active) || !frame.active.startsWith(`./${layout.directory}/`)) return null;
		if (typeof frame.files !== "number" || !Number.isSafeInteger(frame.files) || frame.files < 0) return null;
		return { op: "finalized", active: frame.active, files: frame.files };
	}
	return null;
}

/**
 * Terminal frame of one declaration round: `finalized` after a commit, `verified` after a reuse check.
 * A `miss` is only produced by a verify round (`absent` = nothing installed, `conflict` = installed but
 * different, which must never be overwritten silently).
 */
type DeclarationRoundOutcome = { status: "terminal"; active: string; files: number } | { status: "miss"; reason: "absent" | "conflict" } | { status: "aborted"; reason: "requested" | "eof" } | { status: "error"; code: string } | { status: "timeout" };

/**
 * Drive one finalize run over an existing staging session: send the frames in order and wait for the
 * entry's single terminal frame. The subscription is always released, including on timeout.
 */
export function runBootstrapFinalize(session: BootstrapSession, manifest: RemoteBundleManifest, options: BootstrapFinalizeOptions = {}): Promise<BootstrapFinalizeOutcome> {
	return runDeclarationRound(session, manifest, options, "commit").then((outcome) => {
		if (outcome.status === "terminal") return { status: "finalized" as const, active: outcome.active, files: outcome.files };
		// A verify-only answer cannot complete a commit: report it as the incomplete round it is.
		if (outcome.status === "miss") return { status: "error" as const, code: "BOOTSTRAP_FINALIZE_INCOMPLETE" };
		return outcome;
	});
}

export type BootstrapVerifyOutcome = { status: "verified"; active: string; files: number } | { status: "absent" } | { status: "conflict" } | { status: "aborted"; reason: "requested" | "eof" } | { status: "error"; code: string } | { status: "timeout" };

/**
 * Ask the frozen entry to re-prove an already active bundle against the declaration main just sent.
 * `verified` is the only answer that lets main skip the transfer; `absent` continues with the ordinary
 * staging upload, and `conflict` is fail-closed (an installed-but-different directory is never replaced
 * by an upload).
 */
export function runBootstrapVerify(session: BootstrapSession, manifest: RemoteBundleManifest, options: BootstrapFinalizeOptions = {}): Promise<BootstrapVerifyOutcome> {
	return runDeclarationRound(session, manifest, options, "verify").then((outcome) => {
		if (outcome.status === "terminal") return { status: "verified" as const, active: outcome.active, files: outcome.files };
		if (outcome.status === "miss") return { status: outcome.reason };
		return outcome;
	});
}

function runDeclarationRound(session: BootstrapSession, manifest: RemoteBundleManifest, options: BootstrapFinalizeOptions, mode: "commit" | "verify"): Promise<DeclarationRoundOutcome> {
	if (typeof session?.write !== "function" || typeof session?.onStdoutLine !== "function" || typeof session?.onExit !== "function") return Promise.reject(new Error("BOOTSTRAP_INPUT_INVALID"));
	const activeDirectory = bootstrapTargetLayout(options.target ?? "helper").directory;
	let frames: string[];
	try {
		frames = mode === "verify" ? buildVerifyFrames(manifest, options) : buildFinalizeFrames(manifest, options);
	} catch (error) {
		return Promise.reject(toStableError(error));
	}
	const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) > 0 ? Math.min(options.timeoutMs as number, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
	const timers: BootstrapTimers = options.timers ?? { setTimeout: (handler, delayMs) => setTimeout(handler, delayMs), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };
	return new Promise<DeclarationRoundOutcome>((resolve, reject) => {
		let settled = false;
		let terminatorIssued = false;
		let timer: unknown;
		let unsubscribe: (() => void) | undefined;
		let unsubscribeExit: (() => void) | undefined;
		// A cancel before the terminator frame ends the round as aborted. A commit that is already on the
		// wire may have happened, so it can only be reported as unconfirmed; a verify round has no side
		// effect to be unsure about.
		const onAbort = (): void => finish(mode === "commit" && terminatorIssued ? { status: "error", code: "BOOTSTRAP_FINALIZE_UNCONFIRMED" } : { status: "aborted", reason: "requested" });
		const release = (): void => {
			if (timer !== undefined) timers.clearTimeout(timer);
			unsubscribe?.();
			unsubscribe = undefined;
			unsubscribeExit?.();
			unsubscribeExit = undefined;
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (outcome: DeclarationRoundOutcome): void => {
			if (settled) return;
			settled = true;
			release();
			resolve(outcome);
		};
		const abort = (error: unknown): void => {
			if (settled) return;
			settled = true;
			release();
			reject(toStableError(error));
		};
		// The deadline is armed before subscribing, so a session that answers synchronously still gets
		// its timer cleared instead of leaving one armed for two minutes.
		timer = timers.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
		if (options.signal?.aborted === true) {
			finish({ status: "aborted", reason: "requested" });
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			unsubscribe = session.onStdoutLine((line) => {
				const frame = decodeBootstrapResult(line, options.target);
				if (frame === null || frame.op === "ready") return;
				if (frame.op === "aborted") return finish({ status: "aborted", reason: frame.reason });
				if (frame.op === "error") return finish({ status: "error", code: frame.code });
				// A previous round's queued successor must not complete this round before its terminator left.
				if (frame.op === "verify-miss") {
					if (mode !== "verify" || !terminatorIssued) return;
					return finish({ status: "miss", reason: frame.reason });
				}
				// Bind the terminal frame to the manifest we just sent: the remote must not be able to name
				// another active path or claim a different file count.
				const expected = `./${activeDirectory}/${manifest.bundleSha256}`;
				if (frame.op === "finalized") {
					if (mode !== "commit") return;
					if (!terminatorIssued) return finish({ status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
					if (frame.active !== expected) return finish({ status: "error", code: "BOOTSTRAP_ACTIVE_CONFLICT" });
					if (frame.files !== manifest.files.length) return finish({ status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
					return finish({ status: "terminal", active: frame.active, files: frame.files });
				}
				if (mode !== "verify") return;
				if (!terminatorIssued) return finish({ status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
				if (frame.active !== expected) return finish({ status: "error", code: "BOOTSTRAP_ACTIVE_CONFLICT" });
				if (frame.files !== manifest.files.length) return finish({ status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
				finish({ status: "terminal", active: frame.active, files: frame.files });
			});
			if (!settled) {
				// Launcher emits exit only after draining stdout, so a final protocol frame wins over exit.
				unsubscribeExit = session.onExit(() => finish({ status: "error", code: "BOOTSTRAP_FINALIZE_UNCONFIRMED" }));
			}
		} catch (error) {
			abort(error);
			return;
		}
		if (settled) {
			release();
			return;
		}
		try {
			for (const [index, line] of frames.entries()) {
				if (settled) break;
				session.write(line);
				if (index === frames.length - 1) terminatorIssued = true;
			}
		} catch (error) {
			// The transport refused a frame (session already gone): report it once and drop the listener.
			abort(error);
		}
	});
}
