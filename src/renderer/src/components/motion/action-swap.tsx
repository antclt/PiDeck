"use client";
// beui.dev/components/motion/action-swap
//
// 包装层：根据设置开关在「官方原版 / PiDeck 定制变体」之间切换。
// 定制版用 useLayoutEffect 测量宽度实现过渡；官方版为 cascade 逐字动画。props 签名一致。

import { useBeuiOfficial } from "@/hooks/useBeuiOfficial";
import {
  ActionSwapText as CustomActionSwapText,
  ActionSwapIcon as CustomActionSwapIcon,
  ActionSwapButton as CustomActionSwapButton,
} from "./action-swap.custom";
import {
  ActionSwapText as OfficialActionSwapText,
  ActionSwapIcon as OfficialActionSwapIcon,
  ActionSwapButton as OfficialActionSwapButton,
} from "@/components/beui-official/motion/action-swap";

export type {
  ActionSwapItem,
  ActionSwapButtonVariant,
  ActionSwapButtonSize,
  ActionSwapAnimation,
  ActionSwapButtonProps,
  ActionSwapTextProps,
  ActionSwapIconProps,
} from "./action-swap.custom";

type ActionSwapTextProps = import("./action-swap.custom").ActionSwapTextProps;
type ActionSwapIconProps = import("./action-swap.custom").ActionSwapIconProps;
type ActionSwapButtonProps = import("./action-swap.custom").ActionSwapButtonProps;

export function ActionSwapText(props: ActionSwapTextProps) {
  const official = useBeuiOfficial();
  return official ? (
    <OfficialActionSwapText {...props} />
  ) : (
    <CustomActionSwapText {...props} />
  );
}

export function ActionSwapIcon(props: ActionSwapIconProps) {
  const official = useBeuiOfficial();
  return official ? (
    <OfficialActionSwapIcon {...props} />
  ) : (
    <CustomActionSwapIcon {...props} />
  );
}

export function ActionSwapButton(props: ActionSwapButtonProps) {
  const official = useBeuiOfficial();
  return official ? (
    <OfficialActionSwapButton {...props} />
  ) : (
    <CustomActionSwapButton {...props} />
  );
}
