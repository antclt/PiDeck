import { useAtomValue } from "jotai";
import { beuiOfficialComponentsAtom } from "../atoms/app-ui-atoms";

/**
 * 读取「是否使用 beUI 官方原版组件」开关。
 * 由 App 从 settings.useOfficialBeuiComponents 同步写入原子；
 * beUI 组件包装层据此在「官方原版 / PiDeck 定制变体」之间切换实现。
 */
export function useBeuiOfficial(): boolean {
  return useAtomValue(beuiOfficialComponentsAtom);
}
