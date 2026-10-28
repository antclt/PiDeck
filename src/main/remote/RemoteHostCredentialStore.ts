import { safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-host login secrets (SSH password / key passphrase), encrypted with the OS credential store.
 *
 * Why not the host store JSON: that file is backed up, copied and read by every catalog path, so a secret
 * must never be one field away from a plain-text copy. This module keeps a separate small envelope whose
 * values are `safeStorage` ciphertext only - Windows DPAPI, macOS Keychain, Linux Secret Service - and
 * refuses to write anything at all when the platform cannot encrypt (the caller then keeps the secret in
 * memory for the session and reports it, instead of silently degrading to plain text).
 *
 * Editing is the same operation as saving: `set()` replaces the entry for a host, which is how the UI
 * changes a password later. Deleting the host calls `delete()`.
 */
export type StoredSecret = { secret: string };

type CredentialEnvelope = { version: 1; entries: Record<string, string> };

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RemoteHostCredentialStore {
	private readonly filePath: string;
	private writing: Promise<void> = Promise.resolve();

	constructor(userDataDir: string) {
		this.filePath = join(userDataDir, "remote-credentials.json");
	}

	/** True when this platform can encrypt at rest; when false nothing is ever written. */
	available(): boolean {
		try {
			return safeStorage.isEncryptionAvailable();
		} catch {
			return false;
		}
	}

	/** Store (or replace) one host's secret. Returns false when the platform cannot encrypt. */
	async set(hostId: string, secret: string): Promise<boolean> {
		if (!HOST_ID.test(hostId) || typeof secret !== "string" || secret.length === 0 || secret.length > 4096) return false;
		if (!this.available()) return false;
		let cipher: string;
		try {
			cipher = safeStorage.encryptString(secret).toString("base64");
		} catch {
			return false;
		}
		return this.mutate((envelope) => ({ ...envelope, entries: { ...envelope.entries, [hostId]: cipher } }));
	}

	/** Decrypt one host's secret; any read/decrypt failure is "no stored secret", never a thrown error. */
	async get(hostId: string): Promise<string | undefined> {
		if (!HOST_ID.test(hostId) || !this.available()) return undefined;
		const envelope = await this.read();
		const cipher = envelope?.entries[hostId];
		if (typeof cipher !== "string") return undefined;
		try {
			const secret = safeStorage.decryptString(Buffer.from(cipher, "base64"));
			return secret.length > 0 && secret.length <= 4096 ? secret : undefined;
		} catch {
			return undefined;
		}
	}

	async delete(hostId: string): Promise<void> {
		if (!HOST_ID.test(hostId)) return;
		await this.mutate((envelope) => {
			if (!(hostId in envelope.entries)) return envelope;
			const entries = { ...envelope.entries };
			delete entries[hostId];
			return { ...envelope, entries };
		});
	}

	private async read(): Promise<CredentialEnvelope | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			if (!parsed || typeof parsed !== "object") return undefined;
			const value = parsed as Record<string, unknown>;
			if (value.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) return undefined;
			const entries: Record<string, string> = {};
			for (const [hostId, cipher] of Object.entries(value.entries as Record<string, unknown>)) {
				if (HOST_ID.test(hostId) && typeof cipher === "string" && cipher.length > 0 && cipher.length <= 16 * 1024) entries[hostId] = cipher;
			}
			return { version: 1, entries };
		} catch {
			return undefined;
		}
	}

	/** Serialize writes and replace the file atomically; a failed write leaves the previous file intact. */
	private mutate(change: (envelope: CredentialEnvelope) => CredentialEnvelope): Promise<boolean> {
		const run = this.writing.then(async () => {
			const current = (await this.read()) ?? { version: 1, entries: {} };
			const next = change(current);
			const directory = dirname(this.filePath);
			const temporary = `${this.filePath}.tmp`;
			try {
				await mkdir(directory, { recursive: true });
				await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
				await rename(temporary, this.filePath);
				return true;
			} catch {
				await rm(temporary, { force: true }).catch(() => undefined);
				return false;
			}
		});
		this.writing = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}
