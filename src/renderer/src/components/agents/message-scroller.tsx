"use client";
// beui.dev/components/agents/message-scroller
//
// 包装层：根据设置开关在「官方原版 / PiDeck 定制变体」之间切换。
// 定制版换用 use-stick-to-bottom 引擎并暴露 scrollApiRef（供时间线 controller /
// RPC 日志回底按钮调用），官方版无该字段、改用 PreviewRail 导航。
// 这里保留定制版的 props 签名（含 scrollApiRef / MessageScrollerScrollApi），
// 切官方时剥离 scrollApiRef（官方实现不支持程序化滚动 API）。

import { useBeuiOfficial } from "@/hooks/useBeuiOfficial";
import {
  MessageScroller as CustomMessageScroller,
  type MessageScrollerProps,
} from "./message-scroller.custom";
import { MessageScroller as OfficialMessageScroller } from "@/components/beui-official/agents/message-scroller";

export type {
  MessageScrollerScrollApi,
  MessageScrollerProps,
} from "./message-scroller.custom";

export function MessageScroller(props: MessageScrollerProps) {
  const official = useBeuiOfficial();
  if (official) {
    // 官方版没有 scrollApiRef；剥离该定制字段后其余 props 兼容转发。
    const { scrollApiRef: _scrollApiRef, ...rest } = props;
    return <OfficialMessageScroller {...rest} />;
  }
  return <CustomMessageScroller {...props} />;
}
