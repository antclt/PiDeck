/**
 * DSH 凭证明文读取辅助（纯函数，可单测）。
 *
 * DSH 的 credentials RPC 刻意不回显值（describe 只给 configured/source/writable），
 * 配置页「眼睛」需要明文时由主进程直接读 `$DSH_HOME/.credentials.yaml`（严格
 * ref→value 映射，与 dsh-credentials-local 同一文档格式），环境变量层只读兜底。
 *
 * 解析失败一律视为未配置：describe 侧会如实报告状态，这里不重复抛错。
 */
import { load } from "js-yaml";

/** ref 合法性：POSIX 标识符（与 dsh-credentials 的 credentialRef 同规则），防路径注入。 */
export function isValidCredentialRef(ref: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref);
}

/**
 * 从凭证文档文本解析单个 ref 的值。
 * @param text - `.credentials.yaml` 文档文本。
 * @param ref - 凭证引用（环境变量名）。
 * @returns 明文值；ref 不存在、文档缺失/畸形或值非字符串时返回 undefined。
 *
 * 兼容两种布局（dsh-credentials-local 的 v1 官方格式 + 迁移前的扁平旧布局）：
 * - v1：`{ version: 1, refs: { <ref>: value } }`（官方唯一接受的新格式）；
 * - 扁平：`{ <ref>: value }`（pre-release 旧布局，官方已拒绝但旧文件可能残留）。
 * 优先读 v1 的 refs 层，找不到再回退扁平顶层，保证两种文件都能读到。
 */
export function credentialValueFromDocument(text: string, ref: string): string | undefined {
	if (!isValidCredentialRef(ref)) return undefined;
	let parsed: unknown;
	try {
		parsed = load(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const root = parsed as Record<string, unknown>;
	// DSH 官方 v1：{ version: 1, refs: { <ref>: value } }
	const refs = root["refs"];
	if (refs && typeof refs === "object" && !Array.isArray(refs)) {
		const nested = (refs as Record<string, unknown>)[ref];
		if (typeof nested === "string" && nested.length > 0) return nested;
	}
	// 旧扁平布局兜底：{ <ref>: value }
	const value = root[ref];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
