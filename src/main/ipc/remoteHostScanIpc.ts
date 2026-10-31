import { readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostConfigScanResult } from "../../shared/types/remoteHost";
import { parseSshConfig } from "../remote/SshConfigCandidates";

/** ssh config is a small text file; anything larger is not the file we mean to read. */
const MAX_SSH_CONFIG_BYTES = 1024 * 1024;

/**
 * 主机扫描域：把 `~/.ssh/config` 与 `~/.ssh` 下的私钥候选交给表单。
 *
 * 只读、不联网、不改任何配置；从 `remoteHostIpc` 拆出是为了让那个文件留在体量红线内，
 * 依赖只有 `enabled` 开关。
 */
export function registerRemoteHostScanIpc(input: { enabled: boolean }): void {
	/** Names of likely private keys in `~/.ssh`; files are listed, never opened. */
	async function scanSshIdentityFiles(): Promise<string[]> {
		const directory = join(homedir(), ".ssh");
		const excluded = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "authorized_keys2", "environment", "rc"]);
		const found: string[] = [];
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				const name = entry.name;
				if (!entry.isFile() || name.startsWith(".") || excluded.has(name) || name.endsWith(".pub")) continue;
				if (!name.startsWith("id_") && !/\.(pem|key|ppk)$/i.test(name)) continue;
				found.push(join(directory, name));
				if (found.length >= 32) break;
			}
		} catch {
			// No ~/.ssh: config candidates and manual entry still work.
		}
		return found;
	}

	async function scanSshConfig(): Promise<RemoteHostConfigScanResult> {
		const currentUser = safeCurrentUser();
		const path = join(homedir(), ".ssh", "config");
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (code === "ENOENT") return { ok: true, candidates: [], skipped: [], user: currentUser, identityFiles: await scanSshIdentityFiles() };
			return { ok: false, code: "REMOTE_HOST_CONFIG_UNREADABLE" };
		}
		if (text.length > MAX_SSH_CONFIG_BYTES) return { ok: false, code: "REMOTE_HOST_CONFIG_TOO_LARGE" };
		const parsed = parseSshConfig(text);
		return { ok: true, candidates: parsed.candidates, skipped: parsed.skipped, user: currentUser, identityFiles: await scanSshIdentityFiles() };
	}

	/** The login user, used only as the displayed default when a config entry omits `User`. */
	function safeCurrentUser(): string {
		try {
			return userInfo().username;
		} catch {
			return "";
		}
	}

	ipcMain.handle(ipcChannels.remoteHostScanConfig, async (): Promise<RemoteHostConfigScanResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		return scanSshConfig();
	});
}
