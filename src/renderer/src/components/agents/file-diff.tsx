"use client";
// beui.dev/components/agents/file-diff
//
// 包装层：根据设置开关在「官方原版 / PiDeck 定制变体」之间切换。
// 两个实现的 props 签名一致，直接转发即可。

import { useBeuiOfficial } from "@/hooks/useBeuiOfficial";
import { FileDiff as CustomFileDiff } from "./file-diff.custom";
import { FileDiff as OfficialFileDiff } from "@/components/beui-official/agents/file-diff";

export type {
  FileDiffStatus,
  FileDiffLineType,
  FileDiffLine,
  FileDiffProps,
} from "./file-diff.custom";

export function FileDiff(props: import("./file-diff.custom").FileDiffProps) {
  const official = useBeuiOfficial();
  return official ? <OfficialFileDiff {...props} /> : <CustomFileDiff {...props} />;
}
