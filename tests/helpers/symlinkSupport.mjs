import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 这台机器能不能造「文件符号链接」。
 *
 * Windows 上创建文件符号链接需要管理员权限或开发者模式（非特权进程直接 EPERM），而目录 junction
 * 不需要。远端 helper 的一批用例必须造出真实的文件链接才能证明「stat/list 描述链接本身、read
 * 拒绝它、搜索不跟随它」——这类断言不能被桩替代，也不该在没有能力造链接的机器上假装通过。
 *
 * 返回 `undefined` 表示可用；否则返回一段可以直接交给 `test({ skip })` 的理由。
 * 结果按进程缓存：探测本身要建一次临时链接。
 */
let probed = false;
let cached;

export function fileSymlinkSkipReason() {
	if (probed) return cached;
	probed = true;
	const directory = mkdtempSync(join(tmpdir(), "pideck-symlink-probe-"));
	try {
		const target = join(directory, "target.txt");
		writeFileSync(target, "probe");
		symlinkSync(target, join(directory, "link.txt"), process.platform === "win32" ? "file" : undefined);
		cached = undefined;
	} catch (error) {
		cached = `file symlinks are unavailable on this platform (${error?.code ?? "unknown"}); the link cases were skipped`;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	return cached;
}
