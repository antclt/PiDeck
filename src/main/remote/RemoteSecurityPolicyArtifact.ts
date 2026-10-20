/**
 * 远端安全策略快照的原子写入（P4.4 扩展面，配合 runner 1.1.0 的 `PIDECK_*` env）。
 *
 * 为什么需要单独一条写通道：security-gate 扩展读 `PIDECK_SECURITY_CONFIG` 指向的**远端文件**，
 * 而 helper 的写权限只覆盖项目根，部署包又是内容寻址不可变（策略随会话等级变化）。这里用一个
 * 固定内联脚本把快照写到 `<deployRoot>/security-policy.json`：目标是**由主进程固定推导**的路径
 * （不接受调用方拼），内容是 stdin 上的一行 base64，脚本自己校验字节数与 sha256 后才原子替换。
 *
 * 边界（fail closed）：
 * - deployRoot 必须是 `<HOME>/.pideck/remote-host`，目录必须是当前用户私有（同 sweep 的判据）；
 * - 快照 ≤ 256 KiB、base64 单行、解码后长度与 sha256 必须与命令行声明一致；
 * - 写临时文件 → fsync → chmod 0600 → rename（同目录原子替换），失败不碰旧文件。
 */
import { createHash } from "node:crypto";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";
import { isRemoteRunnerAbsolutePath } from "./RemoteRunnerContract";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshLauncherHandle, SshProcessLauncher } from "./RemoteHostConnectionTypes";

/** 固定入口名（与远端脚本里的字面量一一对应）。 */
export const REMOTE_SECURITY_ARTIFACT_ENTRY = "--pideck-security-artifact-v1";
/** 结果标记前缀；构造与解析用同一函数，两侧不会漂移。 */
export const REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX = "PIDECK_SECURITY_";
export const REMOTE_SECURITY_ARTIFACT_FILE_NAME = "security-policy.json";
export const REMOTE_SECURITY_ARTIFACT_MAX_BYTES = 256 * 1024;

export const REMOTE_SECURITY_ARTIFACT_CODES = {
	inputInvalid: "SECURITY_ARTIFACT_INPUT_INVALID",
	rootInvalid: "SECURITY_ARTIFACT_ROOT_INVALID",
	mismatch: "SECURITY_ARTIFACT_MISMATCH",
	writeFailed: "SECURITY_ARTIFACT_WRITE_FAILED",
	internal: "SECURITY_ARTIFACT_INTERNAL",
} as const;
const ENTRY_CODES = Object.values(REMOTE_SECURITY_ARTIFACT_CODES);

/**
 * 固定内联脚本。只使用 node:fs / node:path 与 WebCrypto；argv 逐个校验；stdout 只写一条
 * `<marker><json>`。单行且不用单引号，便于作为 shell 参数下发（与冻结 sweep 同一风格）。
 */
export const REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE = String.raw`"use strict";
const fs=require("node:fs"),path=require("node:path");
const ENTRY=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_ENTRY)};
const SHA=/^[0-9a-f]{64}$/;
const MARKER=/^${REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX}[A-Za-z0-9]{8,64}$/;
const CONTROL=/[\u0000-\u001f\u007f]/;
const MAX_BYTES=${REMOTE_SECURITY_ARTIFACT_MAX_BYTES};
const MAX_B64=Math.ceil(MAX_BYTES/3)*4+8;
const FILE_NAME=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_FILE_NAME)};
const INPUT_INVALID=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid)};
const ROOT_INVALID=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_CODES.rootInvalid)};
const MISMATCH=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_CODES.mismatch)};
const WRITE_FAILED=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_CODES.writeFailed)};
const INTERNAL=${JSON.stringify(REMOTE_SECURITY_ARTIFACT_CODES.internal)};
const argv=process.argv.slice(1);
const marker=argv.length===5&&MARKER.test(argv[1])?argv[1]:"";
function out(value){process.stdout.write(marker+JSON.stringify(value))}
function fail(code){if(marker)out({ok:false,code:code});process.exitCode=1}
function canonical(value){
	if(typeof value!=="string"||value.length===0||value.length>4096||!path.isAbsolute(value)||CONTROL.test(value))return false;
	if(value!==path.normalize(value)||value===path.dirname(value))return false;
	const segments=value.split(path.sep),start=segments[0]===""?1:0;
	return !segments.slice(start).some(function(segment){return segment===""||segment==="."||segment===".."});
}
function privateDir(target){
	let stat=null;
	try{stat=fs.lstatSync(target)}catch{return null}
	if(!stat.isDirectory()||stat.isSymbolicLink())return null;
	if(typeof process.getuid==="function"){if(stat.uid!==process.getuid())return null;if((stat.mode&0o077)!==0)return null}
	return stat;
}
try{
	if(argv.length!==5||argv[0]!==ENTRY||marker==="")fail(INPUT_INVALID);
	else{
		const deployRoot=argv[2],sha=argv[3],bytes=Number(argv[4]);
		const home=process.env.HOME;
		if(!canonical(deployRoot)||!SHA.test(sha)||!Number.isSafeInteger(bytes)||bytes<0||bytes>MAX_BYTES)fail(INPUT_INVALID);
		else if(!canonical(home)||deployRoot!==path.join(home,".pideck","remote-host")||privateDir(deployRoot)===null)fail(ROOT_INVALID);
		else{
			/* 输入是一行 base64（见到换行即处理）。不等 EOF：pinned ssh 会话在产品里是「写完等结果、由调用方
			   关会话语」，不会关 stdin；等 EOF 会让每次推送都超时。 */
			let data="";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data",function(chunk){
				if(data.length>MAX_B64+1)return fail(INPUT_INVALID);
				data+=chunk;
				const breakAt=data.indexOf("\n");
				if(breakAt<0)return;
				const text=data.slice(0,breakAt).trim();
				data="";
				(async function(){
					if(text.length===0||text.length>MAX_B64)return fail(INPUT_INVALID);
					const buffer=Buffer.from(text,"base64");
					if(buffer.length!==bytes)return fail(MISMATCH);
					const digest=Buffer.from(await crypto.subtle.digest("SHA-256",buffer)).toString("hex");
					if(digest!==sha)return fail(MISMATCH);
					const target=path.join(deployRoot,FILE_NAME),temporary=target+".tmp";
					try{
						fs.writeFileSync(temporary,buffer,{mode:0o600});
						const fd=fs.openSync(temporary,"r+");
						try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
						fs.chmodSync(temporary,0o600);
						fs.renameSync(temporary,target);
						try{const dirFd=fs.openSync(deployRoot,"r");try{fs.fsyncSync(dirFd)}catch{}try{fs.closeSync(dirFd)}catch{}}catch{}
					}catch{
						try{fs.unlinkSync(temporary)}catch{}
						return fail(WRITE_FAILED);
					}
					out({ok:true,bytes:buffer.length});
				})().catch(function(){fail(INTERNAL)});
			});
		}
	}
}catch{fail(INTERNAL)}
`
	.replace(/\s+/g, " ")
	.trim();

/** 结果标记（构造与解析必须用同一个函数）。 */
export function remoteSecurityArtifactMarker(nonce: unknown): string {
	if (typeof nonce !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(nonce)) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid);
	return `${REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX}${nonce}`;
}

/** 远端目标的唯一权威路径（主进程只有一个地方拼它）：部署根下的稳定文件名。 */
export function remoteSecurityPolicyPath(deployRoot: string): string {
	if (!isRemoteRunnerAbsolutePath(deployRoot)) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid);
	return `${deployRoot}/${REMOTE_SECURITY_ARTIFACT_FILE_NAME}`;
}

/** 构造一条固定的远端命令；任何 token 不合法就抛稳定码，一个字节都不发。 */
export function buildRemoteSecurityArtifactCommand(input: { nodePath: unknown; deployRoot: unknown; bytes: unknown; sha256: unknown; nonce: unknown }): { command: string; marker: string } {
	const nodePath = typeof input?.nodePath === "string" && isRemoteRunnerAbsolutePath(input.nodePath) && input.nodePath.slice(input.nodePath.lastIndexOf("/") + 1) === "node" ? input.nodePath : undefined;
	const deployRoot = isRemoteRunnerAbsolutePath(input?.deployRoot) ? input.deployRoot : undefined;
	const bytes = typeof input?.bytes === "number" && Number.isSafeInteger(input.bytes) && input.bytes >= 0 && input.bytes <= REMOTE_SECURITY_ARTIFACT_MAX_BYTES ? input.bytes : undefined;
	const sha256 = typeof input?.sha256 === "string" && /^[0-9a-f]{64}$/.test(input.sha256) ? input.sha256 : undefined;
	const marker = remoteSecurityArtifactMarker(input?.nonce);
	if (nodePath === undefined || deployRoot === undefined || bytes === undefined || sha256 === undefined) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid);
	const command = [nodePath, "-e", REMOTE_SECURITY_ARTIFACT_INLINE_SOURCE, "--", REMOTE_SECURITY_ARTIFACT_ENTRY, marker, deployRoot, sha256, String(bytes)].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid);
	return { command, marker };
}

/** 严格解析一条结果：`<marker>{"ok":true,"bytes":n}` 或闭集错误码。 */
export function parseRemoteSecurityArtifactResult(stdout: unknown, marker: unknown): { ok: true; bytes: number } {
	if (typeof stdout !== "string" || typeof marker !== "string" || !marker.startsWith(REMOTE_SECURITY_ARTIFACT_MARKER_PREFIX)) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.internal);
	const start = stdout.indexOf(marker);
	if (start < 0) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.internal);
	let value: unknown;
	try {
		value = JSON.parse(stdout.slice(start + marker.length));
	} catch {
		throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.internal);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.internal);
	const frame = value as Record<string, unknown>;
	if (frame.ok === false) {
		const code = ENTRY_CODES.find((known) => known === frame.code);
		throw new Error(code ?? REMOTE_SECURITY_ARTIFACT_CODES.internal);
	}
	if (frame.ok !== true || typeof frame.bytes !== "number" || !Number.isSafeInteger(frame.bytes) || frame.bytes < 0 || frame.bytes > REMOTE_SECURITY_ARTIFACT_MAX_BYTES) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.internal);
	return { ok: true, bytes: frame.bytes };
}

/**
 * 把一份策略快照写到远端部署根（原子替换）。
 *
 * 失败抛闭集稳定码；调用方按「安全门不可用」降级，不把会话启动拖垮。
 */
export async function writeRemoteSecurityPolicySnapshot(input: { userDataDir: string; hostId: string; generation: number; nodePath: string; deployRoot: string; bytes: Buffer | Uint8Array; client: SshClientRuntime; launcher: SshProcessLauncher; nonce: string; timeoutMs?: number }): Promise<void> {
	const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
	if (bytes.length < 1 || bytes.length > REMOTE_SECURITY_ARTIFACT_MAX_BYTES) throw new Error(REMOTE_SECURITY_ARTIFACT_CODES.inputInvalid);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const { command, marker } = buildRemoteSecurityArtifactCommand({ nodePath: input.nodePath, deployRoot: input.deployRoot, bytes: bytes.length, sha256, nonce: input.nonce });
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: command });
	const timeoutMs = Number.isSafeInteger(input.timeoutMs) && (input.timeoutMs as number) > 0 ? (input.timeoutMs as number) : 30_000;
	const handle: SshLauncherHandle = await input.launcher.start({ hostId: input.hostId, generation: input.generation, invocation, stdin: true, timeoutMs, maxOutputBytes: 64 * 1024, maxLineBytes: Math.ceil(REMOTE_SECURITY_ARTIFACT_MAX_BYTES / 3) * 4 + 64 });
	try {
		const outcome = await new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			let unsubscribeExit: (() => void) | undefined;
			const finish = (value: { ok: true } | { ok: false; code: string }): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				unsubscribeExit?.();
				resolve(value);
			};
			const timer = setTimeout(() => finish({ ok: false, code: REMOTE_SECURITY_ARTIFACT_CODES.internal }), timeoutMs);
			// 先订阅再写：结果行可能在写完之后立刻到达。
			unsubscribe = handle.onStdoutLine((line) => {
				if (!line.includes(marker)) return;
				try {
					parseRemoteSecurityArtifactResult(line, marker);
					finish({ ok: true });
				} catch (error) {
					finish({ ok: false, code: error instanceof Error ? error.message : REMOTE_SECURITY_ARTIFACT_CODES.internal });
				}
			});
			unsubscribeExit = handle.onExit(() => finish({ ok: false, code: REMOTE_SECURITY_ARTIFACT_CODES.internal }));
			try {
				handle.write(bytes.toString("base64"));
			} catch {
				finish({ ok: false, code: REMOTE_SECURITY_ARTIFACT_CODES.internal });
			}
		});
		if (!outcome.ok) throw new Error(outcome.code);
	} finally {
		await handle.stop("shutdown").catch(() => undefined);
	}
}
