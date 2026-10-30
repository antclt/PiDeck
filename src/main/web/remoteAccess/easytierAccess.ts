/**
 * EasyTier 渠道：定位 easytier-cli、读取本地节点虚拟 IP。
 *
 * EasyTier 是去中心化 P2P 虚拟局域网，没有类似 `tailscale serve` 的入口管理命令：
 * 只要 Web 服务监听 0.0.0.0（默认），同一 EasyTier 网络里的设备就能用虚拟 IP 直连。
 * 因此这个渠道是只读的——PiDeck 不启动/停止 EasyTier，只读取节点信息并生成地址。
 *
 * 数据来源（均为只读命令，参数数组传递、不经 shell）：
 * - `easytier-cli -o json node`：NodeInfo.ipv4_addr 形如 "10.144.144.1/24"。
 * - `easytier-cli node`：旧版/JSON 不可用时的 markdown 表格，解析 "Virtual IP" 行。
 * - 手动虚拟 IP：EasyTier GUI 默认模式使用进程内 Ring RPC，不监听 127.0.0.1:15888，
 *   此时 CLI 读不到节点；由用户从客户端抄写虚拟 IP（设置项 webRemoteEasyTierIp）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { AppLogger } from "../../logging/AppLogger";

const execFileAsync = promisify(execFile);

/** 可注入的命令执行器：测试用替身返回构造好的输出，不跑真实 CLI。 */
export type EasyTierCommandFn = (args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

/** 从 node 输出里提炼出的最小字段集。 */
export type EasyTierNodeInfo = {
	ip: string;
	hostname: string;
	version: string;
};

/** 单次探测结果；installed/binaryPath 由 RemoteAccessManager 维护。 */
export type EasyTierProbeResult = {
	running: boolean;
	ip: string;
	hostname: string;
	version: string;
	ipSource: "cli" | "manual" | "";
	error: string;
};

const EMPTY_NODE_INFO: EasyTierNodeInfo = { ip: "", hostname: "", version: "" };

/**
 * 归一化虚拟 IPv4：去掉 CIDR 后缀、去空白，校验点分十进制与 0/广播地址；
 * 非法返回空串（手动输入与 CLI 输出共用同一口径）。
 */
export function normalizeEasyTierIpv4(value: unknown): string {
	if (typeof value !== "string") return "";
	const candidate = value.trim().split("/")[0]?.trim() ?? "";
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
	if (!match) return "";
	const parts = match.slice(1).map(Number);
	if (parts.some((part) => part < 0 || part > 255)) return "";
	if (parts[0] === 0 || parts.every((part) => part === 255)) return "";
	return parts.join(".");
}

/** 定位 easytier-cli：PATH + 各平台常见安装目录兜底；找不到返回空串。 */
export function detectEasyTierBinary(): string {
	const exeName = "easytier-cli" + (process.platform === "win32" ? ".exe" : "");
	const candidates: string[] = [];
	const pathValue = process.env.PATH || process.env.Path || "";
	for (const dir of pathValue.split(delimiter)) {
		if (dir.trim()) candidates.push(join(dir, exeName));
	}
	if (process.platform === "win32") {
		// 官方安装脚本 / GUI 安装器 / scoop / 手动解压的常见目录
		for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
			if (!base) continue;
			candidates.push(join(base, "EasyTier", exeName), join(base, "easytier", exeName), join(base, "easytier-gui", exeName), join(base, "Programs", "EasyTier", exeName), join(base, "Programs", "easytier-gui", exeName));
		}
	} else if (process.platform === "darwin") {
		candidates.push(join("/Applications/EasyTier.app/Contents/MacOS", "easytier-cli"), join("/Applications/easytier-gui.app/Contents/MacOS", "easytier-cli"), join("/usr/local/bin", exeName), join("/opt/homebrew/bin", exeName));
	} else {
		candidates.push(join("/opt/easytier", exeName), join("/usr/bin", exeName), join("/usr/local/bin", exeName), join("/usr/sbin", exeName), join(homedir(), ".local", "bin", exeName));
	}
	candidates.push(join(homedir(), ".cargo", "bin", exeName));
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// 单目录不可读不影响继续
		}
	}
	return "";
}

/** CLI 管道输出可能带 ANSI 颜色/BOM；解析前统一清掉，避免正则/JSON 解析被噪声打断。 */
function cleanCliText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\u001b\[[0-9;]*m/g, "");
}

/** 从 -o json 的 NodeInfo 输出中取第一条带虚拟 IP 的节点（单实例对象或多实例数组）。 */
export function parseEasyTierNodeJson(stdout: string): EasyTierNodeInfo {
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleanCliText(stdout));
	} catch {
		return { ...EMPTY_NODE_INFO };
	}
	const candidates = Array.isArray(parsed) ? parsed : [parsed];
	for (const candidate of candidates) {
		const node = unwrapEasyTierJsonNode(candidate);
		if (!node) continue;
		const rawIp = typeof node.ipv4_addr === "string" ? node.ipv4_addr : typeof node.ipv4Addr === "string" ? node.ipv4Addr : "";
		const ip = normalizeEasyTierIpv4(rawIp);
		if (!ip) continue;
		return {
			ip,
			hostname: typeof node.hostname === "string" ? node.hostname : "",
			version: typeof node.version === "string" ? node.version : "",
		};
	}
	return { ...EMPTY_NODE_INFO };
}

/** 多实例 JSON 形如 { instance_id, instance_name, result: NodeInfo }。 */
function unwrapEasyTierJsonNode(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
		return record.result as Record<string, unknown>;
	}
	return record;
}

/** 从旧版 `easytier-cli node` 的 markdown 表格里取 Virtual IP / Hostname。 */
export function parseEasyTierNodeTable(stdout: string): EasyTierNodeInfo {
	const text = cleanCliText(stdout);
	const ipMatch = text.match(/^\|\s*Virtual IP\s*\|\s*([^|]+?)\s*\|/m);
	const hostMatch = text.match(/^\|\s*Hostname\s*\|\s*([^|]+?)\s*\|/m);
	return {
		ip: normalizeEasyTierIpv4(ipMatch?.[1] ?? ""),
		hostname: hostMatch?.[1]?.trim() ?? "",
		version: "",
	};
}

/** 默认命令执行器：execFile 走数组参数，不 spawn shell。 */
function defaultCommandFn(binary: string): EasyTierCommandFn {
	return (args, options) =>
		execFileAsync(binary, args, {
			windowsHide: true,
			timeout: options?.timeoutMs ?? 10_000,
			maxBuffer: 1024 * 1024,
		});
}

/** 提取 CLI 失败的用户可读原因：去掉 execFile 首行的命令行回显，优先 stderr 首个非空行。 */
function readableCommandError(error: unknown, fallbackPrefix: string): string {
	const message = cleanCliText(error instanceof Error ? error.message : String(error));
	const stderrLine = message
		.split("\n")
		.map((line) => line.trim())
		.slice(1)
		.find((line) => line.length > 0);
	return stderrLine ? `${fallbackPrefix}: ${stderrLine}` : `${fallbackPrefix}: ${message}`;
}

/**
 * EasyTier 读取器：每次 probe 即时执行 CLI（无缓存），失败以 error 字段返回。
 * 手动 IP 是 CLI 读不到时的兜底：只要用户填了地址就生成可用状态，running 仅表示 CLI 是否连上节点。
 */
export class EasyTierAccessReader {
	private readonly command: EasyTierCommandFn;
	private readonly manualIp: string;

	constructor(
		private readonly deps: {
			logger: AppLogger;
			binary?: string;
			manualIp?: string;
			commandFn?: EasyTierCommandFn;
		},
	) {
		this.command = deps.commandFn ?? defaultCommandFn(deps.binary ?? "easytier-cli");
		this.manualIp = normalizeEasyTierIpv4(deps.manualIp ?? "");
	}

	async probe(): Promise<EasyTierProbeResult> {
		let coreReachable = false;
		let lastError = "";
		let autoInfo: EasyTierNodeInfo = { ...EMPTY_NODE_INFO };
		try {
			const { stdout } = await this.command(["-o", "json", "node"], { timeoutMs: 4_000 });
			coreReachable = true;
			const info = parseEasyTierNodeJson(stdout);
			if (info.ip) autoInfo = info;
			else lastError = "EasyTier 已运行，但尚未分配虚拟 IP";
		} catch (error) {
			lastError = readableCommandError(error, "easytier-cli 读取节点信息失败");
		}
		if (!autoInfo.ip) {
			try {
				const { stdout } = await this.command(["node"], { timeoutMs: 4_000 });
				coreReachable = true;
				const info = parseEasyTierNodeTable(stdout);
				if (info.ip) autoInfo = info;
				lastError = "EasyTier 已运行，但尚未分配虚拟 IP";
			} catch (error) {
				// JSON 已连上节点时，表格失败不影响「已运行但没 IP」的判断
				if (!coreReachable) lastError = readableCommandError(error, "easytier-cli 读取节点信息失败");
			}
		}
		// 手动地址明确优先于自动检测：用户填了就以它生成 URL，清空后才回到自动结果。
		if (this.manualIp) {
			return { running: coreReachable, ip: this.manualIp, hostname: autoInfo.hostname, version: autoInfo.version, ipSource: "manual", error: "" };
		}
		if (autoInfo.ip) {
			return { running: true, ...autoInfo, ipSource: "cli", error: "" };
		}
		if (!lastError) lastError = "未找到运行中的 EasyTier 节点";
		this.deps.logger.warn("web-remote", "easytier node probe failed", { error: lastError });
		return { running: coreReachable, ip: "", hostname: "", version: "", ipSource: "", error: lastError };
	}
}
