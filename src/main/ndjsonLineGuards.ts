/**
 * stdio NDJSON JSON-RPC 传输的共享护栏（pi RPC 与 ACP 同一套约束，数值刻意对齐）。
 *
 * - 大行延迟解析：超过阈值字符数的行延后到 setImmediate 再 JSON.parse，避免 stdout
 *   data 回调里同步 parse 巨型响应堵住主进程事件循环。
 * - 单行硬上限：无 LF 的失控输出（启动脚本打印二进制/死循环刷屏）会让行缓冲无界增长；
 *   超限即视为「这一帧不可用」，丢帧结算（pi RPC 丢到下一个 LF 重新对齐，ACP 直接关连接）。
 *
 * 上限为什么是 32 MiB：RPC 帧是「一条完整消息 = 一行 JSON」，图片以 base64 内联（体积
 * ×1.33），单张 1920×1200 PNG 就是 2.7～6.2 MB——正常图片工作流的帧就能过 8 MiB（实测单行
 * 会话 JSONL 4.4 MB、线上 RPC 帧 1～9 MB），所以旧值 8 MiB 会把**合法帧**当污染丢，
 * 用户侧表现为图片会话「发得出去收不回来」。
 *
 * 为什么又不再往上抬：主进程老生代堆是 384MB（src/main/v8HeapLimits.ts，OOM 表现为无堆栈闪退），
 * 而解析一条 N MiB 的行需要约 3N MiB 的 JS 堆（行字符串 + 解析出的 payload 字符串 + 开销，
 * 实测 8/16/32/64 MiB 行分别 +24/+47/+96/+192 MiB）外加 2N MiB external Buffer。
 * 主进程正常 JS 峰值约 185MB，32 MiB 行峰值约 280MB（留 100MB 余量），64 MiB 行会到 375MB
 * ——再次贴上 #213 那类 abort 边缘。要支持更大的图，走「图片 blob 引用化」而不是抬这个上限。
 *
 * 消费方：src/main/pi/PiRpcClient.ts（pi RPC）、src/main/acp/AcpConnection.ts（ACP）。
 * 两侧保留各自的旧名 re-export（*_RPC_* / *_ACP_*），测试与调用方不需要改。
 */

/** 大行延迟解析阈值（字符数）。 */
export const LARGE_NDJSON_LINE_PARSE_CHARS = 256 * 1024;

/** 单行缓冲硬上限（字节）。 */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;
