/**
 * MCP server configuration loading.
 *
 * Config is loaded from, in order of precedence:
 *   1. the `PI_MCP_SERVERS` environment variable (a JSON string), then
 *   2. `~/.pi/agent/mcp-servers.json`.
 *
 * Only user-level config is read. Project-local MCP config is intentionally not
 * supported here because MCP servers run arbitrary code; wiring them into a
 * project requires the same trust model as other `.pi` resources.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface StdioServerConfig {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface HttpServerConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
	servers: Record<string, ServerConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return result;
}

function parseServer(value: unknown): ServerConfig | undefined {
	if (!isRecord(value)) return undefined;

	// The format shared by Claude Desktop, Cursor and VS Code omits `type`
	// entirely — a `command` means stdio and a `url` means HTTP — so configs
	// copied from a README work verbatim.
	const type = typeof value.type === "string" ? value.type : typeof value.command === "string" ? "stdio" : "http";

	if (type === "stdio") {
		if (typeof value.command !== "string" || value.command.length === 0) return undefined;
		const server: StdioServerConfig = { type: "stdio", command: value.command };
		if (Array.isArray(value.args) && value.args.every((arg): arg is string => typeof arg === "string")) {
			server.args = value.args;
		}
		const env = parseStringMap(value.env);
		if (env) server.env = env;
		return server;
	}

	if (typeof value.url !== "string" || value.url.length === 0) return undefined;
	const server: HttpServerConfig = { type: "http", url: value.url };
	const headers = parseStringMap(value.headers);
	if (headers) server.headers = headers;
	return server;
}

function parseServerMap(value: unknown): Record<string, ServerConfig> | undefined {
	if (!isRecord(value)) return undefined;
	const servers: Record<string, ServerConfig> = {};
	for (const [name, def] of Object.entries(value)) {
		const server = parseServer(def);
		if (server && name.trim()) servers[name] = server;
	}
	return Object.keys(servers).length > 0 ? servers : undefined;
}

function parseConfig(raw: unknown): McpConfig | undefined {
	if (!isRecord(raw)) return undefined;
	// `mcpServers` is the ecosystem-standard key; `servers` is what this
	// extension used before it accepted both. Support each so users can paste
	// configs straight out of a README.
	const servers = parseServerMap(raw.mcpServers) ?? parseServerMap(raw.servers);
	return servers ? { servers } : undefined;
}

export function loadMcpConfig(): McpConfig | undefined {
	const envRaw = process.env.PI_MCP_SERVERS;
	if (envRaw) {
		try {
			const parsed = parseConfig(JSON.parse(envRaw));
			if (parsed) return parsed;
		} catch {
			// Fall through to the config file below.
		}
	}

	const filePath = path.join(getAgentDir(), "mcp-servers.json");
	try {
		return parseConfig(JSON.parse(fs.readFileSync(filePath, "utf-8")));
	} catch {
		return undefined;
	}
}
