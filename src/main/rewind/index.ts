/**
 * rewind 模块桶出口（P1：checkpoint 文件快照）。
 *
 * 后续接入面：AgentGatewayCapability 加 "rewind"、SessionAgentGateway 加
 * listCheckpoints/getCheckpointDiff/restoreCheckpoint 可选方法、IPC 通道
 * sessions:rewind-list/diff/restore。本模块保持纯 git、零 pi 依赖，
 * 因此文件回退天然跨后端（dsh 会话同一仓库直接可用）。
 */

export {
	createCheckpoint,
	restoreCheckpoint,
	loadCheckpointFromRef,
	listCheckpointRefs,
	loadAllCheckpoints,
	deleteCheckpoint,
	pruneCheckpoints,
	pruneOldSessions,
	diffCheckpoints,
	currentIndexTree,
	toCheckpointSummary,
} from "./checkpointCore.ts";
export type { CheckpointData, CreateCheckpointOpts } from "./checkpointCore.ts";
export {
	ZEROS,
	REF_BASE,
	MAX_UNTRACKED_FILE_SIZE,
	MAX_UNTRACKED_DIR_FILES,
	DEFAULT_MAX_CHECKPOINTS,
	IGNORED_DIR_NAMES,
	MUTATING_TOOLS,
} from "./checkpointConstants.ts";
export {
	shouldIgnoreForSnapshot,
	isLargeFile,
	isLargeDirectory,
	normalizeGitPath,
	isPathWithin,
	isPathWithinAny,
	detectLargeDirs,
	isSafeId,
	sanitizeForRef,
	findClosestCheckpoint,
} from "./checkpointFilter.ts";
