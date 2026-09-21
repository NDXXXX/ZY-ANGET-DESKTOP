import type { McpHttpServer, McpServerConfig, McpServers, McpStdioServer } from "./ipc.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") result[key] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Normalizes one server definition. The format shared by Claude Desktop,
 * Cursor and VS Code omits `type` entirely — a `command` means stdio and a
 * `url` means HTTP — so configs copied from a README work verbatim.
 */
export function normalizeServer(value: unknown): McpServerConfig | undefined {
	if (!isRecord(value)) return undefined;
	const type = typeof value.type === "string" ? value.type : typeof value.command === "string" ? "stdio" : "http";

	if (type !== "stdio") {
		if (typeof value.url !== "string" || value.url.length === 0) return undefined;
		const server: McpHttpServer = { type: "http", url: value.url };
		const headers = parseStringMap(value.headers);
		if (headers) server.headers = headers;
		return server;
	}

	if (typeof value.command !== "string" || value.command.length === 0) return undefined;
	const server: McpStdioServer = { type: "stdio", command: value.command };
	if (Array.isArray(value.args) && value.args.every((arg): arg is string => typeof arg === "string")) {
		server.args = value.args;
	}
	const env = parseStringMap(value.env);
	if (env) server.env = env;
	return server;
}

/**
 * Extracts the server map from a config object. Accepts the ecosystem
 * `mcpServers` key, this app's older `servers` key, a bare map of name to
 * definition, and a single unnamed definition (which gets an inferred name).
 */
export function parseMcpServers(value: unknown): McpServers | undefined {
	if (!isRecord(value)) return undefined;

	const wrapped = isRecord(value.mcpServers) ? value.mcpServers : isRecord(value.servers) ? value.servers : undefined;
	if (wrapped) return toServerMap(wrapped);

	// A single unnamed definition — a lone entry, or a pasted command line that
	// the caller already turned into a config. Named maps have no top-level
	// `command`/`url`, so this check is unambiguous.
	if (typeof value.command === "string" || typeof value.url === "string") {
		const single = normalizeServer(value);
		return single ? { [inferServerName(single)]: single } : undefined;
	}

	return toServerMap(value);
}

function toServerMap(value: unknown): McpServers | undefined {
	if (!isRecord(value)) return undefined;
	const servers: McpServers = {};
	for (const [name, definition] of Object.entries(value)) {
		const server = normalizeServer(definition);
		if (server && name.trim()) servers[name] = server;
	}
	return Object.keys(servers).length > 0 ? servers : undefined;
}

/** Shell-like split that keeps quoted arguments (paths with spaces) intact. */
export function splitCommandLine(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Package/runtime names that make poor server names on their own. */
const genericNames = new Set(["mcp", "server", "latest", "main", "index", "js", "npx", "node", "bunx", "stdio", "v"]);

/** Strips package noise: `mcp-server-fetch` -> `fetch`, `chrome-devtools-mcp` -> `chrome-devtools`. */
function stripPackageAffixes(name: string): string {
	let result = name;
	for (;;) {
		const next = result.replace(/^(?:server|mcp)-/i, "").replace(/-mcp$/i, "");
		if (next === result || !next) return result;
		result = next;
	}
}

function nameCandidates(token: string): string[] {
	const withoutVersion = token.replace(/@(latest|next|canary|beta|\d[^@/]*)$/i, "");
	const segments = withoutVersion.split("/").filter(Boolean);
	const base = segments.pop() ?? "";
	const scope = segments.pop();

	const candidates: string[] = [];
	for (const candidate of [base, scope]) {
		if (!candidate) continue;
		const cleaned = candidate.replace(/\.(js|mjs|cjs|ts)$/i, "").replace(/^@/, "");
		candidates.push(stripPackageAffixes(cleaned), cleaned);
	}
	return candidates;
}

function sanitize(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function firstUsefulName(tokens: string[]): string | undefined {
	for (const token of tokens) {
		if (token.startsWith("-")) continue;
		for (const candidate of nameCandidates(token)) {
			const name = sanitize(candidate);
			if (name && /[a-z]/.test(name) && !genericNames.has(name)) return name;
		}
	}
	return undefined;
}

function isPathToken(token: string): boolean {
	return token.startsWith("/") || token.startsWith("~") || token.startsWith(".");
}

/** Best-effort server name, so a pasted command line needs no extra input. */
export function inferServerName(server: McpServerConfig): string {
	if (server.type === "http") {
		try {
			const url = new URL(server.url);
			const segment = url.pathname.split("/").filter(Boolean).pop();
			// `mcp.context7.com` -> `context7`, but keep single-label hosts like `localhost`.
			const labels = url.hostname.replace(/^www\./, "").split(".");
			const host = (labels.length > 1 ? labels.slice(0, -1) : labels).reverse();
			return firstUsefulName([segment ?? "", ...host]) ?? "remote";
		} catch {
			return "remote";
		}
	}

	// Arguments come before the command so a runner (`npx`, `uvx`) is never the
	// name, and path arguments are a last resort so `…filesystem /data` stays
	// `filesystem`.
	const args = server.args ?? [];
	return (
		firstUsefulName(args.filter((token) => !isPathToken(token))) ??
		firstUsefulName(args) ??
		firstUsefulName([server.command]) ??
		"server"
	);
}
