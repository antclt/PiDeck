import { atom } from "jotai";
import type { AgentBackend } from "../../../shared/types";
import {
  defaultExpandedSidebarProjects,
  readExpandedSidebarProjects,
} from "../utils/sidebarExpandedProjects";

/** Settings overlay visibility is shared by Sidebar, Pi environment flow, and Session surface. */
export const settingsOpenAtom = atom(false);

/**
 * 新建会话默认后端（设置项 defaultAgentBackend 的渲染层快照）。
 * App 在 settings 变化时写入；并行问询等不持有 settings props 的根级组件读取。
 * 默认 "pi"（与 SettingsStore.defaultSettings 保持一致，2026-12 兼容期调整）。
 */
export const defaultAgentBackendAtom = atom<AgentBackend>("pi");

/**
 * 侧栏展开的项目 id 集合（有 id = 展开）。
 * Shared because project collapse also pauses App-level session polling.
 * 初值取 localStorage 首屏缓存，随后由 settings.json 覆盖为权威值。
 */
export const sidebarExpandedProjectIdsAtom = atom<ReadonlySet<string>>(
  (() => {
    const cached = readExpandedSidebarProjects(
      typeof window === "undefined" ? undefined : window.localStorage,
    );
    return cached ? new Set(cached) : defaultExpandedSidebarProjects();
  })(),
);

// useStreamdownRendererAtom 已移除：Streamdown 转正为唯一 markdown 引擎（迁移 react-markdown 完成）。

/**
 * 流式对话行为设置快照（App 从 settings 同步写入，TurnRow 直接订阅）。
 * 与 showThinking 的 props 透传不同：这两个开关影响深层 turn 组件，
 * 且变更低频（仅设置修改时），全局 atom 订阅成本可忽略。
 * 默认值与 main SettingsStore.defaultSettings 保持一致。
 */
export type TurnFlowSettings = {
	/** 流式对话时展开中间过程（默认开：最新轮流式输出时自动展开思考/工具详情）。 */
	expandInterimDuringStream: boolean;
	/** 新一轮开始时收起上一轮（默认开：发送新消息后收起所有非最新轮，含手动展开的）。 */
	collapsePrevRunsOnNewTurn: boolean;
	/** 本轮修改文件列表默认展开（默认开；关闭后每轮仍可手动展开）。 */
	expandTurnFileChanges: boolean;
};

export const turnFlowSettingsAtom = atom<TurnFlowSettings>({
	expandInterimDuringStream: true,
	collapsePrevRunsOnNewTurn: true,
	expandTurnFileChanges: true,
});

