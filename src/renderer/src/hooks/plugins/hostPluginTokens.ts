/**
 * 注入给插件面板的宿主设计 token。
 *
 * 插件运行在独立 webview 里，拿不到 PiDeck 的 class 体系，只能靠这组 CSS 变量把
 * 「列表、按钮、输入框、下拉、弹层」画成和宿主一致的样子（颜色 / 圆角 / 阴影 /
 * 控件高度 / 字号 / 字体）。新增 token 时同步 docs/host-plugin-dev-guide.md §5.7；
 * 宿主策略上限 40 个、单值 ≤400 字符（见 hostPluginPolicy.parsePluginContext）。
 */
export const HOST_PLUGIN_THEME_TOKENS = [
	"--color-bg-app",
	"--color-bg-panel",
	"--color-bg-input",
	"--color-bg-muted",
	"--color-bg-hover",
	"--color-bg-active",
	"--color-bg-popover",
	"--color-text-primary",
	"--color-text-secondary",
	"--color-text-tertiary",
	"--color-text-faint",
	"--color-text-inverse",
	"--color-border-subtle",
	"--color-border-default",
	"--color-border-strong",
	"--color-accent",
	"--color-accent-strong",
	"--color-accent-soft",
	"--color-danger",
	"--color-success",
	"--radius-sm",
	"--radius-md",
	"--radius-lg",
	"--radius-xl",
	"--radius-pill",
	"--shadow-popover",
	"--shadow-modal",
	"--control-height-sm",
	"--control-height-md",
	"--control-height-lg",
	"--font-size-micro",
	"--font-size-caption",
	"--font-size-control",
	"--font-size-body",
	"--font-size-title",
	"--font-family-base",
	"--font-family-mono",
] as const;
