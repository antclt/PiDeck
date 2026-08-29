/**
 * beUI「官方原版 / PiDeck 定制变体」A/B 开关（临时，不走设置 UI）。
 *
 * 用法：把下面的布尔值改成 true 即全局切到官方原版，改回 false 用定制变体；
 * dev 模式下保存文件即时生效（必要时 Ctrl+R 刷新）。
 *
 * 注意：临时切回 false（定制变体）排查主题/视觉问题——官方原版组件
 * 与 PiDeck 主题系统的兼容性收敛中。
 *
 * 这套双轨（beui-official/ + *.custom.tsx + wrapper）收敛后，
 * 本文件与开关一起删除。
 */
export const USE_OFFICIAL_BEUI = false;

/**
 * 读取「是否使用 beUI 官方原版组件」开关。
 * beUI 组件包装层据此在「官方原版 / PiDeck 定制变体」之间切换实现。
 */
export function useBeuiOfficial(): boolean {
  return USE_OFFICIAL_BEUI;
}
