/**
 * CUA MCP registration helper.
 *
 * Writes/updates the `pideck-cua` entry in ~/.pi/agent/mcp.json so pi's
 * pi-mcp-adapter connects to the CUA MCP server.
 *
 * Plan A (T7 decision): the CUA MCP server runs inside the PiDeck main process
 * and is exposed over Streamable HTTP on 127.0.0.1. We therefore register a
 * `url` entry (not a stdio `command`), with bearer auth so the adapter does not
 * attempt OAuth discovery.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CUA_SERVER_NAME = "pideck-cua";

export type CuaMcpRegistration = {
  /** MCP Streamable HTTP endpoint, e.g. http://127.0.0.1:31415/mcp. */
  url: string;
  /** Static bearer token required by the host. */
  bearerToken: string;
};

/** Default keep-alive so pi reuses one session while PiDeck is running. */
const CUA_LIFECYCLE = "keep-alive";

/**
 * Ensure the CUA MCP server is registered in ~/.pi/agent/mcp.json.
 * Does NOT clobber other servers. Idempotent.
 */
export function ensureCuaMcpRegistered(registration: CuaMcpRegistration): { written: boolean; path: string } {
  const piAgentDir = join(homedir(), ".pi", "agent");
  const mcpJsonPath = join(piAgentDir, "mcp.json");

  let config: { mcpServers?: Record<string, unknown> } = {};

  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    } catch {
      // Corrupt file; start fresh.
      config = {};
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const newDef = {
    url: registration.url,
    auth: "bearer" as const,
    bearerToken: registration.bearerToken,
    lifecycle: CUA_LIFECYCLE,
  };

  const existing = config.mcpServers[CUA_SERVER_NAME];
  if (existing && JSON.stringify(existing) === JSON.stringify(newDef)) {
    return { written: false, path: mcpJsonPath };
  }

  config.mcpServers[CUA_SERVER_NAME] = newDef;

  if (!existsSync(piAgentDir)) {
    mkdirSync(piAgentDir, { recursive: true });
  }

  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf8");
  return { written: true, path: mcpJsonPath };
}

/**
 * Remove the CUA MCP server registration from mcp.json.
 */
export function unregisterCuaMcp(): { removed: boolean; path: string } {
  const mcpJsonPath = join(homedir(), ".pi", "agent", "mcp.json");

  if (!existsSync(mcpJsonPath)) {
    return { removed: false, path: mcpJsonPath };
  }

  let config: { mcpServers?: Record<string, unknown> };
  try {
    config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  } catch {
    return { removed: false, path: mcpJsonPath };
  }

  if (!config.mcpServers || !config.mcpServers[CUA_SERVER_NAME]) {
    return { removed: false, path: mcpJsonPath };
  }

  delete config.mcpServers[CUA_SERVER_NAME];
  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf8");
  return { removed: true, path: mcpJsonPath };
}
