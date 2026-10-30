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
 *
 * CLI 定位（官方 Windows 包是「ZIP 解压即用」或 winget 便携包，都不写 PATH）：
 * 用户指定路径 → PATH 快照 → 常见安装目录 → 注册表（重读 PATH + 卸载信息里的安装目录）。
 * 只靠前两项时，装完再点「重新检测」永远找不到——这是历史 bug 的根因。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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

const CLI_EXE_NAME = "easytier-cli" + (process.platform === "win32" ? ".exe" : "");

/** existsSync 包一层：非法路径字符/不可读目录不该中断整轮探测。 */
function isFile(candidate: string): boolean {
	try {
		return existsSync(candidate);
	} catch {
		return false;
	}
}

/**
 * 归一化用户指定的 CLI 路径：目录自动补 easytier-cli[.exe]，文件原样返回。
 * 路径不存在返回空串，由调用方回落到自动检测。
 */
function resolvePreferredCli(value: string): string {
	// 资源管理器「复制为路径」自带引号；容忍它，免得用户粘进来就失败
	const raw = value.trim();
	const trimmed = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).trim() : raw;
	if (!trimmed) return "";
	try {
		const stat = statSync(trimmed);
		if (stat.isDirectory()) {
			const nested = join(trimmed, CLI_EXE_NAME);
			return isFile(nested) ? nested : "";
		}
		return stat.isFile() ? trimmed : "";
	} catch {
		return "";
	}
}

/** PATH 环境变量里的目录（进程启动时的快照）。 */
function processPathCandidates(): string[] {
	const candidates: string[] = [];
	for (const dir of (process.env.PATH || process.env.Path || "").split(delimiter)) {
		if (dir.trim()) candidates.push(join(dir.trim(), CLI_EXE_NAME));
	}
	return candidates;
}

/** 各平台常见安装目录兜底：官方 GUI 安装器、winget/scoop/chocolatey、手动解压。 */
function commonInstallCandidates(): string[] {
	const candidates: string[] = [];
	if (process.platform === "win32") {
		for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
			if (!base) continue;
			candidates.push(join(base, "EasyTier", CLI_EXE_NAME), join(base, "easytier", CLI_EXE_NAME), join(base, "easytier-gui", CLI_EXE_NAME), join(base, "Programs", "EasyTier", CLI_EXE_NAME), join(base, "Programs", "easytier", CLI_EXE_NAME), join(base, "Programs", "easytier-gui", CLI_EXE_NAME));
		}
		// 包管理器装的 CLI 只落 shim/link 目录，不在 PATH 快照里也能命中
		const localAppData = process.env.LOCALAPPDATA;
		const userProfile = process.env.USERPROFILE || homedir();
		const programData = process.env.ProgramData;
		if (localAppData) candidates.push(join(localAppData, "Microsoft", "WinGet", "Links", CLI_EXE_NAME));
		if (programData) candidates.push(join(programData, "chocolatey", "bin", CLI_EXE_NAME));
		candidates.push(join(userProfile, "scoop", "shims", CLI_EXE_NAME));
	} else if (process.platform === "darwin") {
		candidates.push(join("/Applications/EasyTier.app/Contents/MacOS", "easytier-cli"), join("/Applications/easytier-gui.app/Contents/MacOS", "easytier-cli"), join("/usr/local/bin", CLI_EXE_NAME), join("/opt/homebrew/bin", CLI_EXE_NAME));
	} else {
		candidates.push(join("/opt/easytier", CLI_EXE_NAME), join("/usr/bin", CLI_EXE_NAME), join("/usr/local/bin", CLI_EXE_NAME), join("/usr/sbin", CLI_EXE_NAME), join(homedir(), ".local", "bin", CLI_EXE_NAME));
	}
	candidates.push(join(homedir(), ".cargo", "bin", CLI_EXE_NAME));
	return candidates;
}

/** 跑一条 reg query（异步，避免整表扫描阻塞主进程）；失败/超时一律空串。 */
async function runRegQuery(args: string[], timeoutMs: number): Promise<string> {
	if (process.platform !== "win32") return "";
	try {
		const { stdout } = await execFileAsync("reg", args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
		return stdout;
	} catch {
		return "";
	}
}

/** 读注册表字符串值；非 Windows / 键不存在 / 超时一律空串。 */
async function readRegistryValue(key: string, name: string): Promise<string> {
	const stdout = await runRegQuery(["query", key, "/v", name], 1_500);
	const match = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, "mi").exec(stdout);
	return match?.[1]?.trim() ?? "";
}

/** 展开注册表 Path 里的 %VAR%（HKLM 的 Path 是 REG_EXPAND_SZ）。 */
function expandWindowsEnv(value: string): string {
	return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? whole);
}

/**
 * 从注册表重新读 PATH：PiDeck 启动后新装的工具只改了注册表，
 * 进程内 process.env.PATH 仍是旧快照——不重读就会一直「检测不到」。
 */
async function registryPathCandidates(): Promise<string[]> {
	if (process.platform !== "win32") return [];
	const candidates: string[] = [];
	for (const key of ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"]) {
		const raw = await readRegistryValue(key, "Path");
		if (!raw) continue;
		for (const dir of expandWindowsEnv(raw).split(";")) {
			if (dir.trim()) candidates.push(join(dir.trim(), CLI_EXE_NAME));
		}
	}
	return candidates;
}

/**
 * 从卸载信息里找安装目录：官方 GUI 安装器无论装到哪都会写 InstallLocation/DisplayIcon，
 * 解压版没有这条记录，只能靠用户指定路径。
 */
async function registryInstallCandidates(): Promise<string[]> {
	if (process.platform !== "win32") return [];
	const roots = ["HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"];
	const dirs = new Set<string>();
	// 三个根并行查：单根整表扫描要几百毫秒，串行会拖慢「重新检测」的响应
	const outputs = await Promise.all(roots.map((root) => runRegQuery(["query", root, "/s"], 2_500)));
	for (const stdout of outputs) {
		// 一次性拉全量再在 JS 里过滤：reg 的 /f、/i 在不同 Windows 版本上支持不一致，靠不住
		if (!stdout) continue;
		// 每条记录之间空行分隔；只认名称/路径里带 easytier 的条目
		for (const block of stdout.split(/\r?\n\s*\r?\n/)) {
			if (!/easytier/i.test(block)) continue;
			for (const line of block.split(/\r?\n/)) {
				const match = /^\s+(InstallLocation|DisplayIcon|UninstallString)\s+REG_\w+\s+(.+)$/i.exec(line);
				if (!match) continue;
				const raw = match[2]!.trim().replace(/^"|"$/g, "");
				// DisplayIcon 常带 ",0" 图标序号；UninstallString 指向卸载器本身
				const dir = /\.exe/i.test(raw) ? dirname(raw.replace(/,\d+$/, "")) : raw;
				// MSI 卸载串是 "MsiExec.exe /X{...}" 这类无目录值，只收盘符/UNC 绝对路径
				const absolute = /^[a-z]:[\\/]/i.test(dir) || dir.startsWith("\\\\");
				if (absolute) dirs.add(dir);
			}
		}
	}
	// winget/解压版常见布局是 <安装目录>/<架构或版本子目录>/easytier-cli.exe，往下多看一层
	const candidates: string[] = [];
	for (const dir of dirs) {
		candidates.push(join(dir, CLI_EXE_NAME));
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) candidates.push(join(dir, entry.name, CLI_EXE_NAME));
			}
		} catch {
			// 目录不可读就只试自身
		}
	}
	return candidates;
}

/**
 * 定位 easytier-cli，找不到返回空串。
 *
 * 顺序：用户指定路径 → PATH → 常见安装目录 → 注册表（PATH 快照 + 卸载信息）。
 * 官方 Windows 安装方式是「ZIP 解压即用」，没有固定目录也不写 PATH，
 * 所以注册表与显式路径是解压版唯一可靠的来源。
 */
export async function detectEasyTierBinary(preferredPath = ""): Promise<string> {
	const preferred = resolvePreferredCli(preferredPath);
	if (preferred) return preferred;
	for (const candidate of processPathCandidates()) {
		if (isFile(candidate)) return candidate;
	}
	for (const candidate of commonInstallCandidates()) {
		if (isFile(candidate)) return candidate;
	}
	// 注册表兜底只在前面都没命中时跑（整表扫描有开销，走异步不阻塞主进程），覆盖「安装后才启动/才点重检」
	const registryCandidates = [...(await registryPathCandidates()), ...(await registryInstallCandidates())];
	for (const candidate of registryCandidates) {
		if (isFile(candidate)) return candidate;
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
