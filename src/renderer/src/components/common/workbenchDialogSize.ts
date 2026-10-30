/**
 * 工作台型弹窗（设置 / Pi·DSH 配置 / 资源管理）的共享尺寸常量（Wave 2 §5.3 工作台型模板）。
 *
 * 此前 SettingsModal 与 ConfigModal 各自维护一份完全相同的尺寸串（80vw×80vh、
 * sm 断点封顶 1300px），ProjectResourcesModal 又手写第三份变体——三处漂移过
 * 视觉尺寸。收敛到单一定义：壳层（高度策略）允许差异，宽度与封顶统一。
 *
 * 用法：`className={cn(WORKBENCH_DIALOG_SIZE_CLASS, "config-modal")}`。
 * 高度特殊需求（如资源管理 760px 封顶）继续由调用方叠加自己的 h-* 类覆盖，
 * 本常量不承载所有变体，只消灭「无意识的复制」。
 */
export const WORKBENCH_DIALOG_SIZE_CLASS = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";
