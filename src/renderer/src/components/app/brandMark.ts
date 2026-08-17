/**
 * 应用内品牌标资源：与 `build/icon.svg` 同源的几何跳蛛（去水印正式标）。
 *
 * 256px PNG 由 `build/icon.svg` 导出，体积约 19KB，足够侧栏/空态/启动页，
 * 不必把系统图标那份 1024 data-URI 再塞进渲染进程。
 */
export const brandMarkSrc = new URL("../../assets/brand-mark.png", import.meta.url).href;
