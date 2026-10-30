/**
 * EasyTier 托管：把本机 easytier-core 装成系统服务，按 PiDeck 设置生成配置并启停。
 *
 * 为什么用系统服务而不是子进程：Windows 下创建 TUN 需要管理员权限，Electron 无法带 UAC
 * 直接 CreateProcess 且拿不到子进程句柄。`easytier-cli service install/start/stop` 把提权
 * 收敛到一次安装，之后启停只走服务控制，界面上不再反复弹 UAC。
 *
 * 配置下发：服务安装时通过 `-c <toml>` 固定配置文件路径；改配置 = 重写文件 + 重装服务。
 * TOML 字段与 `easytier-core` 启动时自己打印的配置块保持一致（GUI 的 parse_config 也吃这套）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppLogger } from "../../logging/AppLogger";

const execFileAsync = promisify(execFile);

/** Windows 服务名：与 easytier-cli 的默认值一致。 */
export const EASYTIER_SERVICE_NAME = "easytier";

/** 托管配置（全部来自设置，主进程不额外持有副本）。 */
export type EasyTierManagedConfig = {
	/** 网络名称（EasyTier 支持中文）。 */
	networkName: string;
	/** 网络密钥。 */
	networkSecret: string;
	/** 共享节点 URL 列表，可为空。 */
	peers: string[];
	/** 固定虚拟 IPv4（不带 CIDR）；空串表示用 DHCP 自动分配。 */
	bindIpv4: string;
	/** 实例名（TOML 的 instance_name，仅用于展示）。 */
	instanceName: string;
};

/** 是否具备托管条件：网络名与密钥都填了。 */
export function isEasyTierConfigReady(config: Partial<EasyTierManagedConfig> | null | undefined): boolean {
	return Boolean(config?.networkName?.trim() && config?.networkSecret?.trim());
}

/** 服务状态（通过 sc query 探测，不需要提权）。 */
export type EasyTierServiceInfo = {
	installed: boolean;
	running: boolean;
};

/**
 * 生成 EasyTier core 的 TOML 配置。
 * 只输出 core 自己 dump 过的字段，避免 GUI 的 parse_config 遇到未知键报错。
 */
export function buildEasyTierToml(config: EasyTierManagedConfig): string {
	const lines: string[] = [];
	lines.push(`instance_name = ${quoteTomlString(config.instanceName || config.networkName)}`);
	if (config.bindIpv4) {
		lines.push("dhcp = false");
		lines.push(`ipv4 = ${quoteTomlString(config.bindIpv4)}`);
	} else {
		lines.push("dhcp = true");
	}
	lines.push("listeners = [");
	lines.push('    "tcp://0.0.0.0:11010",');
	lines.push('    "udp://0.0.0.0:11010",');
	lines.push('    "wg://0.0.0.0:11011",');
	lines.push("]");
	lines.push('rpc_portal = "0.0.0.0:0"');
	lines.push("");
	lines.push("[network_identity]");
	lines.push(`network_name = ${quoteTomlString(config.networkName)}`);
	lines.push(`network_secret = ${quoteTomlString(config.networkSecret)}`);
	for (const peer of config.peers) {
		lines.push("");
		lines.push("[[peer]]");
		lines.push(`uri = ${quoteTomlString(peer)}`);
	}
	return lines.join("\n") + "\n";
}

/** TOML 基本字符串：转义反斜杠与双引号，杜绝配置注入。 */
function quoteTomlString(value: string): string {
	return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * 解析 `sc query <name>` 输出：不存在时 sc 返回 1060 且 stdout 为空/报错；
 * 存在则含 `STATE` 行，运行中为 `STATE : 4 RUNNING`。
 */
export function parseScQuery(stdout: string, stderr = ""): EasyTierServiceInfo {
	const text = stdout + "\n" + stderr;
	if (/1060|指定的服务未安装|does not exist/i.test(text)) return { installed: false, running: false };
	const installed = /SERVICE_NAME|SERVICE_NAME\s*:/i.test(text);
	if (!installed) return { installed: false, running: false };
	const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(text);
	return { installed: true, running };
}

/** 提权执行器：生产用 PowerShell Start-Process -Verb RunAs，测试注入替身。 */
export type ElevatedRunner = (filePath: string, args: string[]) => Promise<void>;

/** 普通命令执行器（sc query 这类只读探测）。 */
export type CommandRunner = (filePath: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function defaultCommandRunner(): CommandRunner {
	return async (filePath, args) => {
		const { stdout, stderr } = await execFileAsync(filePath, args, { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
		return { stdout: String(stdout), stderr: String(stderr) };
	};
}

/**
 * 默认提权执行器：调 PowerShell 的 Start-Process -Verb RunAs 拉起目标程序。
 * -Wait + -PassThru 后回读 ExitCode，把「用户点了取消」和「命令失败」区分开。
 */
function defaultElevatedRunner(): ElevatedRunner {
	return async (filePath, args) => {
		const argList = args.map((arg) => "'" + arg.replace(/'/g, "''") + "'").join(",");
		const script = `$p = Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -ArgumentList @(${argList}) -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
		await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
	};
}

/**
 * EasyTier 服务托管：状态探测不需要提权，安装/启停需要提权（一次 UAC）。
 * 所有方法失败时抛错，由 RemoteAccessManager 收敛成用户可读的 error 字段。
 */
export class EasyTierServiceHost {
	private readonly logger: AppLogger;
	private readonly cliPath: string;
	private readonly corePath: string;
	private readonly run: CommandRunner;
	private readonly runElevated: ElevatedRunner;

	constructor(deps: { logger: AppLogger; cliPath: string; corePath?: string; commandRunner?: CommandRunner; elevatedRunner?: ElevatedRunner }) {
		this.logger = deps.logger;
		this.cliPath = deps.cliPath;
		this.corePath = deps.corePath ?? "";
		this.run = deps.commandRunner ?? defaultCommandRunner();
		this.runElevated = deps.elevatedRunner ?? defaultElevatedRunner();
	}

	/** 服务是否已安装、是否运行中（sc query，免提权）。 */
	async status(): Promise<EasyTierServiceInfo> {
		if (process.platform !== "win32") return { installed: false, running: false };
		try {
			const { stdout, stderr } = await this.run("sc.exe", ["query", EASYTIER_SERVICE_NAME]);
			return parseScQuery(stdout, stderr);
		} catch (error) {
			// 服务不存在时 sc 返回非零，execFile 抛错；stderr 里带 1060。
			const text = error instanceof Error ? error.message : String(error);
			return parseScQuery("", text);
		}
	}

	/**
	 * 安装（或重装）服务并指向给定配置文件。改配置后重跑即可覆盖。
	 * 需要管理员权限：会弹一次 UAC。
	 */
	async install(configPath: string): Promise<void> {
		const args = ["service", "install"];
		if (this.corePath) args.push("--core-path", this.corePath);
		args.push("-c", configPath);
		this.logger.info("web-remote", "easytier service install", { cliPath: this.cliPath, configPath });
		await this.runElevated(this.cliPath, args);
	}

	/** 卸载服务（改配置前可先卸载，避免残留旧参数）。 */
	async uninstall(): Promise<void> {
		await this.runElevated(this.cliPath, ["service", "uninstall"]);
	}

	async start(): Promise<void> {
		await this.runElevated(this.cliPath, ["service", "start"]);
	}

	async stop(): Promise<void> {
		await this.runElevated(this.cliPath, ["service", "stop"]);
	}
}
