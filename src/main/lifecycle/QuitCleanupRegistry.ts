import { getAppLogger } from "../logging/sharedLogger";

/**
 * 退出清理登记表（C12）：常驻资源（子进程/定时器/watcher/终端/托盘等）在创建处
 * 登记清理函数，应用退出时统一顺序执行。
 *
 * 设计意图（对应 AGENTS.md「退出清单同步登记」）：
 * - 新增常驻资源时在创建处 register，不再改 main/index.ts 的 before-quit；
 * - runAll 顺序执行、单项失败记日志不阻塞其余清理（一个资源清理失败不能拖住退出）；
 * - 返回退订函数，支持运行时动态移除。
 */
export class QuitCleanupRegistry {
	private readonly tasks: Array<{ label: string; fn: () => Promise<void> | void }> = [];

	/** 登记清理任务；返回退订函数（移除本次登记）。 */
	register(label: string, fn: () => Promise<void> | void): () => void {
		this.tasks.push({ label, fn });
		return () => {
			const index = this.tasks.findIndex((task) => task.label === label && task.fn === fn);
			if (index >= 0) this.tasks.splice(index, 1);
		};
	}

	/** 顺序执行全部清理任务；单项失败记日志，不阻断其余任务。 */
	async runAll(): Promise<void> {
		for (const task of this.tasks) {
			try {
				await task.fn();
			} catch (error) {
				getAppLogger()?.error("quit", `cleanup failed: ${task.label}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.tasks.length = 0;
	}
}
