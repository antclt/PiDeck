/**
 * CUA Approval HTTP Server — runs in the PiDeck Electron main process.
 *
 * Listens on 127.0.0.1 and accepts POST /cua-approve requests from
 * the CUA MCP Server process. Forwards approval requests to the
 * renderer via IPC and waits for the user's response.
 *
 * IPC channels:
 *   - cuaApprovalRequest: main → renderer (new approval request)
 *   - cuaApprovalResponse: renderer → main (user's response)
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export type CuaApprovalServerConfig = {
	/** Port to listen on. 0 = auto-select. */
	port: number;
	/** Timeout for approval requests in milliseconds. */
	timeoutMs: number;
};

export type CuaApprovalServerDeps = {
	/** Send approval request to renderer and get response. */
	requestApproval: (approval: CuaApprovalHttpRequest) => Promise<CuaApprovalHttpResponse>;
	onLog?: (level: "info" | "error", message: string) => void;
};

export type CuaApprovalHttpRequest = {
	action: string;
	sessionId: string;
	detail: unknown;
	timestampMs: number;
};

export type CuaApprovalHttpResponse = {
	allowed: boolean;
	reason?: string;
};

export class CuaApprovalServer {
	private server: HttpServer | null = null;
	private actualPort: number = 0;
	private config: CuaApprovalServerConfig;
	private deps: CuaApprovalServerDeps;

	constructor(config: Partial<CuaApprovalServerConfig> = {}, deps: CuaApprovalServerDeps) {
		this.config = {
			port: config.port ?? 0,
			timeoutMs: config.timeoutMs ?? 30000,
		};
		this.deps = deps;
	}

	/**
	 * Start the HTTP server. Returns the actual port.
	 */
	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));

			this.server.on("error", (err) => {
				this.deps.onLog?.("error", `CUA approval server error: ${err.message}`);
			});

			this.server.listen(this.config.port, "127.0.0.1", () => {
				const addr = this.server?.address();
				this.actualPort = typeof addr === "object" && addr ? addr.port : this.config.port;
				this.deps.onLog?.("info", `CUA approval server listening on 127.0.0.1:${this.actualPort}`);
				resolve(this.actualPort);
			});

			this.server.on("error", reject);
		});
	}

	/**
	 * Stop the HTTP server.
	 */
	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => {
				this.server = null;
				resolve();
			});
		});
	}

	/**
	 * Get the actual listening port (0 if not started).
	 */
	getPort(): number {
		return this.actualPort;
	}

	/**
	 * Get the server URL (null if not started).
	 */
	getUrl(): string | null {
		if (this.actualPort === 0) return null;
		return `http://127.0.0.1:${this.actualPort}`;
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST" || req.url !== "/cua-approve") {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ allowed: false, reason: "not_found" }));
			return;
		}

		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (body.length > 1_000_000) {
				res.writeHead(413, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ allowed: false, reason: "payload_too_large" }));
				req.destroy();
			}
		});

		req.on("end", async () => {
			try {
				const parsed = JSON.parse(body) as CuaApprovalHttpRequest;

				// Forward to renderer and wait for response.
				const result = await this.deps.requestApproval(parsed);

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.onLog?.("error", `CUA approval handler error: ${message}`);
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ allowed: false, reason: `internal_error: ${message}` }));
			}
		});

		req.on("error", (err) => {
			this.deps.onLog?.("error", `CUA approval request read error: ${err.message}`);
			if (!res.headersSent) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ allowed: false, reason: "read_error" }));
			}
		});
	}
}
