/**
 * DSH host 的启动依赖；保持窄接口，便于在不 fork Electron utilityProcess 的测试中验证启动语义。
 */
export type DshHostStarter = {
	ensureStarted(): Promise<void>;
};

export type DshHostStartupLogger = {
	warn(scope: string, message: string, detail?: unknown): void | Promise<void>;
};

/**
 * 在应用首帧之后预热 DSH host。
 * 不等待 boot 完成，避免 host 初始化、配置加载或异常影响主窗口可用性；发送链路仍由
 * ensureStarted() 幂等兜底。预热失败只记录诊断日志，用户可从配置概览手动重启恢复。
 */
export function startDshHostInBackground(
	host: DshHostStarter,
	logger: DshHostStartupLogger,
): void {
	void host.ensureStarted().catch((error: unknown) => {
		void logger.warn("dsh-host", "Background DSH host startup failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
}
