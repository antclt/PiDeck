import { createRequire } from "node:module";
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

/**
 * Windows 控制台窗口治理（win32 only）。
 *
 * 背景：DSH host 运行在 Electron utilityProcess 里（无控制台、GUI 主进程拉起），
 * host 内 spawn 的控制台子系统程序（pwsh.exe / cmd 等）在 Windows 上会新开一个
 * 可见的黑色控制台窗口。DSH 官方链路（dsh-subprocess-local.spawnSubprocess）没有传
 * `windowsHide`，spec 也没有对应字段；dsh-web 不弹窗只是因为它的 host 常驻在
 * 终端父进程里，子进程直接继承父控制台。本补丁在 host boot 前包装 child_process 的
 * spawn 系列：调用方未显式指定 `windowsHide` 时注入 true（CREATE_NO_WINDOW，
 * 子进程仍有无形控制台，stdin/stdout 管道不受影响）。
 * node-pty 走原生绑定、不经 child_process，不受影响。
 */

type SpawnOptions = childProcessModule.SpawnOptions;

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

/**
 * 安装补丁（win32 only；platform 参数可注入以便测试）。返回还原函数。
 * 必须在 DSH 各包动态 import 之前调用：dsh-subprocess-local 等模块加载时会捕获
 * child_process.spawn 的引用，补丁先于加载才覆盖得到。
 *
 * 注意：Node 24+ 的内置模块 CJS exports 是只读 getter（plain 赋值会抛
 * "Cannot set property ... which has only a getter"），必须用 defineProperty；
 * 该属性 configurable=true，且 ESM 侧 `import { spawn } from "node:child_process"`
 * 是 live binding——defineProperty 替换后，后续动态 import 的 dsh 包读到的就是补丁版。
 */
export function installHiddenConsolePatch(
	platform: NodeJS.Platform = process.platform,
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

	// spawn(command[, args][, options])：options 在第 2 位（无 args）或第 3 位。
	replaceExport("spawn", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			return originals.spawn(command, argsOrOptions, withHiddenOptions(maybeOptions));
		}
		// spawn(command, options) 形态：options 落在第 2 位，且必须存在（否则无窗口问题）
		return originals.spawn(command, withHiddenOptions(argsOrOptions as SpawnOptions | undefined));
	}) as typeof childProcess.spawn);

	// spawnSync 与 spawn 同形态。
	replaceExport("spawnSync", ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions) => {
		if (Array.isArray(argsOrOptions)) {
			return originals.spawnSync(command, argsOrOptions, withHiddenOptions(maybeOptions));
		}
		return originals.spawnSync(command, withHiddenOptions(argsOrOptions as SpawnOptions | undefined));
	}) as typeof childProcess.spawnSync);

	// exec(command[, options][, callback])：options 恒在第 2 位（callback 在第 3 位）。
	// 运行期重载收窄不了（callback 可选），用 unknown 接住按位判断。
	replaceExport("exec", ((command: string, ...rest: unknown[]) => {
		const maybeCallback = rest[1];
		const options = rest[0] as childProcessModule.ExecOptions | undefined;
		const nextOptions = withHiddenOptions(options);
		if (typeof maybeCallback === "function") {
			return originals.exec(command, nextOptions, maybeCallback as Parameters<typeof originals.exec>[2]);
		}
		return originals.exec(command, nextOptions);
	}) as typeof childProcess.exec);

	// execSync(command[, options])：options 在第 2 位。
	replaceExport("execSync", ((command: string, options?: childProcessModule.ExecSyncOptions) => {
		return originals.execSync(command, withHiddenOptions(options));
	}) as typeof childProcess.execSync);

	// execFile(file[, args][, options][, callback])：callback 恒在末位，options 在
	// args 之后的那个参数位（无 args 时在第 2 位）。Node 的重载带编码变体
	// （ExecFileOptions vs ExecFileOptionsWithStringEncoding），在补丁边界用一个
	// 简化签名收窄（运行期透传原参数，仅注入 windowsHide——边界收窄的正当理由）。
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
			return callback === undefined
				? execFileLike(file, args, withHiddenOptions(options))
				: execFileLike(file, args, withHiddenOptions(options), callback);
		}
		const options = rest[0] as childProcessModule.ExecFileOptions | undefined;
		return callback === undefined
			? execFileLike(file, withHiddenOptions(options))
			: execFileLike(file, withHiddenOptions(options), callback);
	}) as typeof childProcess.execFile);

	// execFileSync(file[, args][, options])：与 execFile 同形态（无 callback）。
	replaceExport("execFileSync", ((file: string, argsOrOptions?: readonly string[] | childProcessModule.ExecFileSyncOptions, maybeOptions?: childProcessModule.ExecFileSyncOptions) => {
		if (Array.isArray(argsOrOptions)) {
			return originals.execFileSync(file, argsOrOptions, withHiddenOptions(maybeOptions));
		}
		return originals.execFileSync(file, withHiddenOptions(argsOrOptions as childProcessModule.ExecFileSyncOptions | undefined));
	}) as typeof childProcess.execFileSync);

	return () => {
		for (const [name, value] of Object.entries(originals) as Array<[keyof typeof originals, unknown]>) {
			Object.defineProperty(childProcess, name, { value, writable: true, configurable: true });
		}
	};
}
