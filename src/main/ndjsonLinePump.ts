/**
 * stdio NDJSON 行泵（Buffer 分段版，PiRpcClient / AcpConnection 共用）。
 *
 * 为什么分段（2027-02 性能审计）：字符串实现 `buffer += chunk` 后立即
 * `indexOf("\n")`——V8 对 cons-string 的 indexOf 要先整段扁平化，每个 data
 * 事件都对已累积全长做一次拷贝+分配，单行响应成本 O(B²/chunkSize)；pi 的大
 * tool_result / get_entries 帧（上限 8MiB）与失控输出都会命中。
 *
 * 分段语义：LF（0x0A）按字节查找，绝不出现在 UTF-8 多字节序列内部，跨 chunk
 * 的多字节字符随完整行一次性 toString，不丢字节；已扫过无 LF 的头块不重扫
 * （headSearchedBytes 只对头块生效——其余块要么整块消费、要么是刚到达当轮
 * 已扫过的尾块）。行尾单个 \r 剥离（NDJSON 对 CRLF 的标准容忍）。
 *
 * 溢出/关闭策略不在泵内：调用方按各自协议语义处理（pi 丢当前帧后重新对齐报协议错误、
 * ACP 先切行再看剩余再关连接），泵只提供 bufferedBytes / peekHead / discardUntilNewline /
 * reset / end。
 */
export type NdjsonLinePump = {
	/** 喂入一个 stdout data chunk（Buffer 或 string），内部完成切行分发。 */
	push(chunk: Buffer | string): void;
	/** 流结束：剩余字节（即使无 LF）作为最后一行吐出后清空。 */
	end(): void;
	/** 清空缓冲，返回丢弃的字节数（协议错误/关闭路径用）。 */
	reset(): number;
	/**
	 * 超限处理（pi RPC 用）：丢弃当前未成行的缓冲，并进入「丢弃字节直到下一个 LF」的重新对齐
	 * 状态，返回此刻丢弃的字节数。**不能只清空缓冲**：超长帧的剩余部分会被当成下一帧的起始，
	 * 其后所有帧边界全错位，请求/响应配对永久失配（图片大帧撑爆行上限时必现）。
	 */
	discardUntilNewline(): number;
	/** 未成行缓冲开头最多 maxBytes 字节的 UTF-8 文本（诊断用：从超长帧里认字段，不吐正文）。 */
	peekHead(maxBytes: number): string;
	/** 当前未成行缓冲的字节数；重新对齐期间恒为 0（调用方不会重复触发超限）。 */
	readonly bufferedBytes: number;
	/** 是否正在丢弃字节直到下一个 LF（重新对齐中）。 */
	readonly discarding: boolean;
};

/**
 * @param onLine 每条完整行（已剥 \r）回调；返回 false 时中止本轮切行
 *   （消费方在回调里关闭连接的场景——对应旧 drainLines 的 while(!closed)）。
 */
export function createNdjsonLinePump(onLine: (line: string) => boolean | void): NdjsonLinePump {
	let chunks: Buffer[] = [];
	let totalBytes = 0;
	let headSearched = 0;
	/** 超长帧丢弃后跳过字节直到下一个 LF，避免把它的尾巴当成新帧起始。 */
	let discarding = false;

	const dispatch = (line: Buffer): boolean => {
		// 行尾单个 \r 剥离（CRLF 容忍）；空行照常分发，由消费方决定跳过
		const body = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
		return onLine(body.toString("utf8")) !== false;
	};

	const drain = (): void => {
		for (;;) {
			// LF 只可能在头块（从已扫边界起）或刚追加的尾块（见模块头注释的不变式）
			const head = chunks[0];
			const headLf = head ? head.indexOf(0x0a, headSearched) : -1;
			if (headLf !== -1) {
				const line = head.subarray(0, headLf);
				const rest = head.subarray(headLf + 1);
				totalBytes -= headLf + 1;
				if (rest.length > 0) {
					chunks[0] = rest;
					headSearched = 0;
				} else {
					chunks.shift();
					headSearched = 0;
				}
				if (!dispatch(line)) return;
				continue;
			}
			if (chunks.length > 1) {
				const lastIdx = chunks.length - 1;
				const last = chunks[lastIdx];
				const lastLf = last.indexOf(0x0a);
				if (lastLf !== -1) {
					// 行跨多块：中间块按不变式整块 LF-free，concat 一次（每行 O(行长)）
					const parts = chunks.slice();
					parts[lastIdx] = last.subarray(0, lastLf);
					const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
					totalBytes -= line.length + 1;
					const rest = last.subarray(lastLf + 1);
					if (rest.length > 0) chunks = [rest];
					else chunks = [];
					headSearched = 0;
					if (!dispatch(line)) return;
					continue;
				}
			}
			headSearched = head ? head.length : 0;
			return;
		}
	};

	/** 清空缓冲并返回丢弃字节数。 */
	const clear = (): number => {
		const dropped = totalBytes;
		chunks = [];
		totalBytes = 0;
		headSearched = 0;
		return dropped;
	};

	return {
		push(chunk: Buffer | string): void {
			let bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			if (bytes.length === 0) return;
			if (discarding) {
				const lf = bytes.indexOf(0x0a);
				// 整块都属于被丢弃的超长帧，没有 LF 就继续跳过
				if (lf === -1) return;
				// LF 结束超长帧：它之后的字节才是下一帧的起始，重新对齐完成
				discarding = false;
				bytes = bytes.subarray(lf + 1);
				if (bytes.length === 0) return;
			}
			chunks.push(bytes);
			totalBytes += bytes.length;
			drain();
		},
		end(): void {
			// 超长帧没等到 LF 就 EOF：残端已随重新对齐放弃，不能当成一行吐出
			if (discarding) {
				discarding = false;
				clear();
				return;
			}
			if (chunks.length === 0) return;
			const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
			chunks = [];
			totalBytes = 0;
			headSearched = 0;
			// 结束时的残行不剥头部（已是完整字节序列）；\r 照常剥
			dispatch(line);
		},
		reset(): number {
			discarding = false;
			return clear();
		},
		discardUntilNewline(): number {
			discarding = true;
			return clear();
		},
		peekHead(maxBytes: number): string {
			const wanted = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
			const parts: Buffer[] = [];
			let taken = 0;
			for (const piece of chunks) {
				if (taken >= wanted) break;
				const slice = piece.subarray(0, wanted - taken);
				parts.push(slice);
				taken += slice.length;
			}
			return Buffer.concat(parts).toString("utf8");
		},
		get bufferedBytes(): number {
			return totalBytes;
		},
		get discarding(): boolean {
			return discarding;
		},
	};
}
