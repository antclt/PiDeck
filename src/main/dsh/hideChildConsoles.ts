import { createRequire } from "node:module";
import { join } from "node:path";
import type * as childProcessModule from "node:child_process";

/**
 * 拿 child_process 的真实 CJS exports 对象。
 * 不能 `import * as childProcess`：tsc 会把命名空间 import 编译成 __importStar 拷贝
 * （拷贝上的 getter 不可配置，defineProperty 替换会抛 "Cannot redefine property"，
 * 且补丁打在拷贝上对真实模块无效）。createRequire 直接返回模块本体，
 * 在测试 vm（__filename 注入）与 electron-vite CJS 产物（__filename 存在）里都成立。
 * 类型用 type-only 别名（childProcess 类型/值双空间不冲突，运行时零开销）。
 */
type childProcess = typeof childProcessModule;
const childProcess = createRequire(__filename)("node:child_process") as typeof childProcessModule;

type SpawnOptions = childProcessModule.SpawnOptions;

/**
 * Windows 控制台窗口治理（win32 only）。
 *
 * 背景（2026-08 实测结论，替代旧的"全量注入 windowsHide"方案）：
 * - DSH host 运行在 Electron utilityProcess 里（GUI 子系统、无控制台）。
 * - child_process.spawn 从无控制台父进程拉起控制台子程序时，libuv 自动带
 *   CREATE_NO_WINDOW——子进程无控制台、不弹窗（spawn 矩阵实测：无控制台父进程
 *   + pipe stdio 的四种 windowsHide 组合，子进程全部 console=False）。因此旧方案
 *   注入 windowsHide 对本地路径毫无作用；且把子进程变成"无控制台"后，若子进程
 *   再拉起控制台程序（cmd 内部再执行等），Windows 会为孙进程新建可见控制台。
 * - 真正的黑窗口来源是沙箱 runner：host 以 GUI 二进制（electron.exe）拉起 runner，
 *   GUI 进程不继承父进程控制台（实测）；runner 用 koffi 直接调
 *   CreateProcessAsUserW(dwCreationFlags=0)（绕过 child_process，补丁够不着），
 *   父进程无控制台时 Windows 为命令进程新建可见控制台窗口。runner 源码注释说明
 *   受限 token 下子进程自行创建控制台会 STATUS_DLL_INIT_FAILED(0xC0000142) 崩溃，
 *   因此不能靠 CREATE_NO_WINDOW——正确做法是让 runner 自身持有隐藏控制台，
 *   子进程继承（继承≠创建，实测受限 token 下继承控制台正常运行）。
 *
 * 治理策略（两级，见 installHostHiddenConsole / installHiddenConsolePatch）：
 * 1) host boot 时用 koffi AllocConsole + SW_HIDE 给 host 分配隐藏控制台。
 *    此后所有 console 子系统子进程（pwsh/git/taskkill/cmd…）与孙进程都继承该
 *    隐藏控制台——整棵树零可见窗口。
 * 2) child_process 补丁仅在分配失败时退回旧的 windowsHide 注入（兜底：直接
 *    子进程至少不弹窗）；并对沙箱 runner 的 spawn 注入
 *    NODE_OPTIONS=--require=<runnerConsolePreload>：runner 不继承 host 控制台，
 *    由 preload 在 runner 进程内自建隐藏控制台。
 */

/** koffi 运行时 FFI 接口子集（测试注入假实现，避免依赖真实原生模块）。 */
export interface Win32Ffi {
	load(name: string): {
		func(signature: string): (...args: unknown[]) => unknown;
	};
}

/** host 是否已持有隐藏控制台（installHostHiddenConsole 置位；补丁据此决定是否注入 windowsHide）。 */
let hostHiddenConsoleActive = false;

/**
 * 给当前进程分配隐藏控制台（win32 only；platform/ffi 可注入以便测试）。
 *
 * utilityProcess 无控制台，分配后所有 console 子系统子进程都会继承它——
 * 这是让整棵进程树（含孙进程）都不弹窗的根本手段。已有控制台（终端拉起等
 * 场景）或分配失败时：已有控制台视为成功（继承即可），分配失败返回 false
 * （调用方退回 windowsHide 注入兜底）。所有异常静默。
 */
export function installHostHiddenConsole(
	platform: NodeJS.Platform = process.platform,
	ffi?: Win32Ffi,
): boolean {
	hostHiddenConsoleActive = false;
	if (platform !== "win32") return false;
	try {
		const koffi = ffi ?? (createRequire(__filename)("koffi") as Win32Ffi);
		const kernel32 = koffi.load("kernel32.dll");
		const user32 = koffi.load("user32.dll");
		const getConsoleWindow = kernel32.func("void* GetConsoleWindow(void)") as () => unknown;
		const allocConsole = kernel32.func("int AllocConsole(void)") as () => number;
		const showWindow = user32.func("int ShowWindow(void* hWnd, int nCmdShow)") as (
			hWnd: unknown,
			nCmdShow: number,
		) => number;
		if (getConsoleWindow()) {
			// 已有控制台：子进程本就继承它，无需再分配（utilityProcess 不应出现，防御）。
			hostHiddenConsoleActive = true;
			return true;
		}
		if (allocConsole() === 0) return false;
		const handle = getConsoleWindow();
		if (handle) showWindow(handle, 0); // SW_HIDE = 0
		hostHiddenConsoleActive = true;
		return true;
	} catch {
		return false; // koffi 缺失/调用失败：退回 windowsHide 注入兜底
	}
}

/** 未显式指定 windowsHide 时注入 true；已指定则尊重原值（Node 默认 false）。 */
export function hiddenConsoleOptions<T extends { windowsHide?: boolean }>(
	options: T | undefined,
): T | undefined {
	if (!options) return undefined;
	return options.windowsHide === undefined ? { ...options, windowsHide: true } : options;
}

/** options 缺失时补一个只含 windowsHide 的对象（insert 语义，与 replace 区分）。 */
function withHiddenOptions<T extends { windowsHide?: boolean }>(options: T | undefined): T {
	if (options === undefined) return { windowsHide: true } as T;
	return hiddenConsoleOptions(options) as T;
}

/** 沙箱 runner 脚本名（lib 产物 runner.js / 开发形态 runner.ts）。 */
const RUNNER_SCRIPT_RE = /runner\.(js|ts)$/i;

/**
 * pwsh 冷启动加速环境变量（实测：405ms → 286ms，省约 30%）。
 * PowerShell 7 启动时检查遥测/更新/首次运行体验，这些检查是启动路径上的真实开销；
 * 本机单用户桌面场景全部无意义，显式关闭。对本地 spawn（pwsh.exe）直接注入，
 * 对沙箱 runner 的 spawn 也注入（CreateProcessAsUserW 的子进程继承 runner 的 env）。
 */
const PWSH_STARTUP_ENV: Record<string, string> = {
	POWERSHELL_TELEMETRY_OPTOUT: "1",
	POWERSHELL_UPDATECHECK: "Off",
	DOTNET_NOLOGO: "1",
	DOTNET_CLI_TELEMETRY_OPTOUT: "1",
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
};

/** command 是否为 pwsh/powershell（本地路径解析与 PATH 裸名都覆盖）。 */
function isPwshCommand(command: string): boolean {
	return /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(command);
}

/** 给 pwsh 相关 spawn 注入启动优化环境变量（env 缺失时跳过：真实链路恒带 env）。 */
function withPwshStartupEnv(
	options: childProcessModule.SpawnOptions | undefined,
	isPwsh: boolean,
): childProcessModule.SpawnOptions | undefined {
	if (!isPwsh || options === undefined || options.env === undefined) return options;
	return { ...options, env: { ...options.env, ...PWSH_STARTUP_ENV } };
}

/**
 * 沙箱 runner 的 spawn 需要注入 NODE_OPTIONS=--require=<preload>：
 * runner 由 GUI 二进制（electron.exe）拉起、不继承 host 控制台，由 preload
 * （runnerConsolePreload）在 runner 进程内自建隐藏控制台，CreateProcessAsUserW
 * 的子进程继承后不再弹窗。env 缺失时跳过（真实链路 spawnSubprocess 恒带 env）。
 */
function withRunnerPreload(
	options: childProcessModule.SpawnOptions | undefined,
	runnerPreloadPath: string,
): childProcessModule.SpawnOptions | undefined {
	if (options === undefined || options.env === undefined) return options;
	const existing = options.env.NODE_OPTIONS;
	// Windows 上 Node 解析 NODE_OPTIONS 时按命令行分词、反斜杠当转义符：
	// `--require="C:\path\a.js"` 会被解析成 `C:patha.js`（MODULE_NOT_FOUND）。
	// 必须把反斜杠翻倍（`\\` → `\`），否则 runner preload 加载失败、沙箱调用全挂。
	const preload = `--require="${runnerPreloadPath.replace(/\\/g, "\\\\")}"`;
	return {
		...options,
		env: {
			...options.env,
			NODE_OPTIONS: existing ? `${existing} ${preload}` : preload,
		},
	};
}

/** 本次 spawn 的 argv 是否指向沙箱 runner（argv 内含 runner.js/runner.ts 路径）。 */
function isRunnerSpawn(command: string, args: readonly string[] | undefined): boolean {
	if (args === undefined) return false;
	return args.some((arg) => typeof arg === "string" && RUNNER_SCRIPT_RE.test(arg));
}

/**
 * 安装补丁（win32 only；platform 可注入以便测试）。返回还原函数。
 * 必须在 DSH 各包动态 import 之前调用：dsh-subprocess-local 等模块加载时会捕获
 * child_process.spawn 的引用，补丁先于加载才覆盖得到。
 *
 * 行为：
 * - host 隐藏控制台生效（installHostHiddenConsole 成功）：不注入 windowsHide，
 *   让子进程继承隐藏控制台（注入 CREATE_NO_WINDOW 反而切断继承、孙进程可能弹窗）。
 * - 分配失败（兜底）：注入 windowsHide（CREATE_NO_WINDOW，直接子进程无窗口）。
 * - 两种模式下都对沙箱 runner 的 spawn 注入 NODE_OPTIONS preload。
 *
 * 注意：Node 24+ 的内置模块 CJS exports 是只读 getter（plain 赋值会抛
 * "Cannot set property ... which has only a getter"），必须用 defineProperty；
 * 该属性 configurable=true，且 ESM 侧 `import { spawn } from "node:child_process"`
 * 是 live binding——defineProperty 替换后，后续动态 import 的 dsh 包读到的就是补丁版。
 */
export function installHiddenConsolePatch(
	platform: NodeJS.Platform = process.platform,
	runnerPreloadPath: string = join(__dirname, "runnerConsolePreload.js"),
): () => void {
	if (platform !== "win32") return () => undefined;
	const originals = {
		spawn: childProcess.spawn,
		spawnSync: childProcess.spawnSync,
		execFile: childProcess.execFile,
		execFileSync: childProcess.execFileSync,
		exec: childProcess.exec,
		execSync: childProcess.execSync,
	};

	/** 用 defineProperty 替换导出（兼容 Node 24 只读 getter 语义）。 */
	function replaceExport<K extends keyof typeof childProcess>(
		name: K,
		value: typeof childProcess[K],
	): void {
		Object.defineProperty(childProcess, name, {
			value,
			writable: true,
			configurable: true,
		});
	}

	/**
	 * 一次 spawn 的 options 决策：runner spawn 恒注入 preload + pwsh 启动环境
	 * （沙箱 pwsh 继承 runner env）；本地 pwsh spawn 注入启动环境；普通 spawn 按
	 * host 隐藏控制台是否生效决定 windowsHide 注入与否。
	 */
	function resolveSpawnOptions(
		command: string,
		args: readonly string[] | undefined,
		options: childProcessModule.SpawnOptions | undefined,
	): childProcessModule.SpawnOptions | undefined {
		if (isRunnerSpawn(command, args)) {
			return withRunnerPreload(
				withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true),
				runnerPreloadPath,
			);
		}
		if (isPwshCommand(command)) {
			return withPwshStartupEnv(hostHiddenConsoleActive ? options : withHiddenOptions(options), true);
		}
		return hostHiddenConsoleActive ? options : withHiddenOptions(options);
	}

	// spawn(command[, args][, options])：options 在第 2 位（无 args）或第 3 位。
	replaceExport("spawn", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const next = resolveSpawnOptions(command, argsOrOptions, maybeOptions);
			return next === undefined
				? originals.spawn(command, argsOrOptions)
				: originals.spawn(command, argsOrOptions, next);
		}
		const next = resolveSpawnOptions(command, undefined, argsOrOptions as SpawnOptions | undefined);
		return next === undefined ? originals.spawn(command) : originals.spawn(command, next);
	}) as typeof childProcess.spawn);

	// spawnSync 与 spawn 同形态。
	replaceExport("spawnSync", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const next = resolveSpawnOptions(command, argsOrOptions, maybeOptions);
			return next === undefined
				? originals.spawnSync(command, argsOrOptions)
				: originals.spawnSync(command, argsOrOptions, next);
		}
		const next = resolveSpawnOptions(command, undefined, argsOrOptions as SpawnOptions | undefined);
		return next === undefined ? originals.spawnSync(command) : originals.spawnSync(command, next);
	}) as typeof childProcess.spawnSync);

	// exec(command[, options][, callback])：options 恒在第 2 位（callback 在第 3 位）。
	// 运行期重载收窄不了（callback 可选），用 unknown 接住按位判断。
	replaceExport("exec", ((command: string, ...rest: unknown[]) => {
		const maybeCallback = rest[1];
		const options = rest[0] as childProcessModule.ExecOptions | undefined;
		const nextOptions = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		if (typeof maybeCallback === "function") {
			return originals.exec(command, nextOptions, maybeCallback as Parameters<typeof originals.exec>[2]);
		}
		return originals.exec(command, nextOptions);
	}) as typeof childProcess.exec);

	// execSync(command[, options])：options 在第 2 位。
	replaceExport("execSync", ((command: string, options?: childProcessModule.ExecSyncOptions) => {
		const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		return originals.execSync(command, next);
	}) as typeof childProcess.execSync);

	// execFile(file[, args][, options][, callback])：callback 恒在末位，options 在
	// args 之后的那个参数位（无 args 时在第 2 位）。Node 的重载带编码变体
	// （ExecFileOptions vs ExecFileOptionsWithStringEncoding），在补丁边界用一个
	// 简化签名收窄（运行期透传原参数，仅调整 windowsHide——边界收窄的正当理由）。
	type ExecFileLike = (
		file: string,
		argsOrOptions: readonly string[] | childProcessModule.ExecFileOptions | undefined,
		optionsOrCallback?: childProcessModule.ExecFileOptions | ((error: unknown, stdout: unknown, stderr: unknown) => void),
		callback?: (error: unknown, stdout: unknown, stderr: unknown) => void,
	) => ReturnType<typeof childProcessModule.execFile>;
	const execFileLike = originals.execFile as ExecFileLike;
	replaceExport("execFile", ((file: string, ...rest: unknown[]) => {
		const hasCallback = typeof rest[rest.length - 1] === "function";
		const callback = hasCallback ? (rest.pop() as (error: unknown, stdout: unknown, stderr: unknown) => void) : undefined;
		if (Array.isArray(rest[0])) {
			const args = rest[0] as readonly string[];
			const options = rest[1] as childProcessModule.ExecFileOptions | undefined;
			const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
			return callback === undefined
				? execFileLike(file, args, next)
				: execFileLike(file, args, next, callback);
		}
		const options = rest[0] as childProcessModule.ExecFileOptions | undefined;
		const next = hostHiddenConsoleActive ? options : withHiddenOptions(options);
		return callback === undefined
			? execFileLike(file, next)
			: execFileLike(file, next, callback);
	}) as typeof childProcess.execFile);

	// execFileSync(file[, args][, options])：与 execFile 同形态（无 callback）。
	replaceExport("execFileSync", ((file: string, argsOrOptions?: readonly string[] | childProcessModule.ExecFileSyncOptions, maybeOptions?: childProcessModule.ExecFileSyncOptions) => {
		if (Array.isArray(argsOrOptions)) {
			const next = hostHiddenConsoleActive ? maybeOptions : withHiddenOptions(maybeOptions);
			return originals.execFileSync(file, argsOrOptions, next);
		}
		const next = hostHiddenConsoleActive ? argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined : withHiddenOptions(argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined);
		return originals.execFileSync(file, next);
	}) as typeof childProcess.execFileSync);

	return () => {
		for (const [name, value] of Object.entries(originals) as Array<[keyof typeof originals, unknown]>) {
			Object.defineProperty(childProcess, name, { value, writable: true, configurable: true });
		}
	};
}
