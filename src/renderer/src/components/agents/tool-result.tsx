"use client";
// beui.dev/components/agents/tool-result
//
// 包装层：根据设置开关在「官方原版 / PiDeck 定制变体」之间切换。
// 两个实现的 props 形状差异较大：定制版有 showHeader/copyClassName，官方版有
// 更丰富的状态图标、折叠与 retry。这里保留定制版的 props 签名（调用方不变），
// 切官方时把公共字段映射过去、丢弃定制专属字段。

import { useBeuiOfficial } from "@/hooks/useBeuiOfficial";
import {
  ToolResult as CustomToolResult,
  type ToolResultProps,
} from "./tool-result.custom";
import { ToolResult as OfficialToolResult } from "@/components/beui-official/agents/tool-result";
import type { ToolResultKind } from "@/components/beui-official/agents/tool-result";

/** 把定制版自由字符串 kind 收窄为官方 ToolResultKind；未知值回落 custom。 */
function toOfficialKind(kind?: string): ToolResultKind | undefined {
  if (kind === "terminal" || kind === "request" || kind === "custom") return kind;
  return undefined;
}

export type { ToolResultProps } from "./tool-result.custom";

export function ToolResult(props: ToolResultProps) {
  const official = useBeuiOfficial();
  if (official) {
    // showHeader / copyClassName 是定制版专属，官方版无对应字段，直接丢弃；
    // tool 官方版必填，定制版可选，缺省回落 null 占位。
    return (
      <OfficialToolResult
        tool={props.tool ?? null}
        title={props.title}
        status={props.status}
        kind={toOfficialKind(props.kind)}
        maxHeight={props.maxHeight}
        copyText={props.copyText}
        contentClassName={props.contentClassName}
      >
        {props.children}
      </OfficialToolResult>
    );
  }
  return <CustomToolResult {...props} />;
}
