/**
 * MCP Extension
 *
 * Connects to external MCP (Model Context Protocol) servers and registers each
 * server's tools as LLM-callable tools, plus a read-only `_read_resource` helper
 * per server. Servers are configured in `~/.pi/agent/mcp-servers.json` (or the
 * `PI_MCP_SERVERS` environment variable); see README.md for the format.
 *
 * Connections are established eagerly on `session_start` (so tools are available
 * in the system prompt) and then reused by every later session in the same
 * process; only the tool registrations are per-session. See
 * docs/mcp-connection-reuse-design.md.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { loadMcpConfig, type ServerConfig } from "./config.ts";
import { createMcpClient, type McpClient, type McpContent, type McpTool } from "./mcp-client.ts";

const CONNECT_TIMEOUT_MS = 30_000;

interface ServerConnection {
	name: string;
	/** The config this connection was established with; compared to detect edits. */
	config: ServerConfig;
	client: McpClient;
	tools: McpTool[];
	connected: boolean;
	error?: string;
}

// Connections outlive a session. `load_session` rebuilds the whole runtime and
// fires `session_shutdown` + `session_start` for every conversation switch, so
// tearing down here would restart every MCP server on each switch — measured at
// ~7s with two npx servers. Only the tool registrations are per-session, because
// a rebuilt runtime has an empty tool registry.
const connections = new Map<string, ServerConnection>();

// The process is going away, so the children have to be killed synchronously.
process.once("exit", () => {
	for (const connection of connections.values()) connection.client.kill();
});

function sameConfig(left: ServerConfig, right: ServerConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

type ToolContent = AgentToolResult<unknown>["content"];

function normalizeToolName(input: string): string | undefined {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized || undefined;
}

function contentToText(items: McpContent[]): string {
	return items
		.map((item) => (item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item)))
		.join("\n");
}

function mapContent(items: McpContent[]): ToolContent {
	const content: ToolContent = [];
	for (const item of items) {
		if (item.type === "text" && typeof item.text === "string") {
			content.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string") {
			content.push({ type: "image", data: item.data, mimeType: item.mimeType || "image/png" });
		} else if (item.type === "resource" && item.resource) {
			const resource = item.resource;
			if (typeof resource.text === "string") {
				content.push({ type: "text", text: resource.text });
			} else if (typeof resource.blob === "string") {
				content.push({
					type: "image",
					data: resource.blob,
					mimeType: resource.mimeType || "application/octet-stream",
				});
			} else {
				content.push({ type: "text", text: JSON.stringify(resource) });
			}
		} else {
			content.push({ type: "text", text: JSON.stringify(item) });
		}
	}
	return content;
}

export default function mcpExtension(pi: ExtensionAPI) {
	// Per-session: the tool registry belongs to the runtime that is being replaced.
	const registeredToolNames = new Set<string>();
	let sessionStarted = false;

	function markBroken(state: ServerConnection, error: unknown): void {
		// Leave the connection flagged so the next session retries it.
		state.connected = false;
		state.error = error instanceof Error ? error.message : String(error);
	}

	async function reconnect(state: ServerConnection): Promise<void> {
		await state.client.close().catch(() => {});
		state.client = createMcpClient(state.config);
		await state.client.connect(AbortSignal.timeout(CONNECT_TIMEOUT_MS));
		state.connected = true;
		state.error = undefined;
	}

	async function callTool(state: ServerConnection, name: string, args: unknown, signal?: AbortSignal) {
		try {
			return await state.client.callTool(name, args, signal);
		} catch (error) {
			try {
				await reconnect(state);
			} catch (reconnectError) {
				markBroken(state, reconnectError);
				throw error;
			}
			return await state.client.callTool(name, args, signal);
		}
	}

	async function readResource(state: ServerConnection, uri: string, signal?: AbortSignal) {
		try {
			return await state.client.readResource(uri, signal);
		} catch (error) {
			try {
				await reconnect(state);
			} catch (reconnectError) {
				markBroken(state, reconnectError);
				throw error;
			}
			return await state.client.readResource(uri, signal);
		}
	}

	function registerServerTools(state: ServerConnection): number {
		let count = 0;

		for (const tool of state.tools) {
			const name = normalizeToolName(`mcp_${state.name}_${tool.name}`);
			if (!name || registeredToolNames.has(name)) continue;
			registeredToolNames.add(name);

			const parameters = Type.Unsafe((tool.inputSchema ?? { type: "object" }) as TSchema);

			pi.registerTool({
				name,
				label: `${state.name}:${tool.name}`,
				description: tool.description ?? `MCP tool ${tool.name} from server ${state.name}`,
				parameters,
				async execute(_toolCallId, params, signal) {
					const result = await callTool(state, tool.name, params, signal);
					if (result.isError) {
						throw new Error(contentToText(result.content) || `MCP tool ${tool.name} reported an error`);
					}
					return {
						content: mapContent(result.content),
						details: { server: state.name, tool: tool.name },
					};
				},
			});
			count++;
		}

		const readName = normalizeToolName(`mcp_${state.name}_read_resource`);
		if (readName && !registeredToolNames.has(readName)) {
			registeredToolNames.add(readName);
			pi.registerTool({
				name: readName,
				label: `${state.name}:read_resource`,
				description: `Read a resource by URI from the ${state.name} MCP server.`,
				parameters: Type.Object({ uri: Type.String({ description: "Resource URI" }) }),
				async execute(_toolCallId, params, signal) {
					const items = await readResource(state, params.uri, signal);
					return {
						content: mapContent(items),
						details: { server: state.name, resource: params.uri },
					};
				},
			});
			count++;
		}

		return count;
	}

	async function connectServer(name: string, serverConfig: ServerConfig, ctx: ExtensionContext): Promise<void> {
		const connection: ServerConnection = {
			name,
			config: serverConfig,
			client: createMcpClient(serverConfig),
			tools: [],
			connected: false,
		};
		connections.set(name, connection);

		try {
			await connection.client.connect(AbortSignal.timeout(CONNECT_TIMEOUT_MS));
			connection.tools = await connection.client.listTools(AbortSignal.timeout(CONNECT_TIMEOUT_MS));
			connection.connected = true;
		} catch (error) {
			connection.error = error instanceof Error ? error.message : String(error);
			await connection.client.close().catch(() => {});
			ctx.ui.notify(`MCP server "${name}" failed to connect: ${connection.error}`, "warning");
			return;
		}

		const count = registerServerTools(connection);
		ctx.ui.notify(`Connected to MCP server "${name}": ${count} tool(s)`, "info");
	}

	/** Drops connections for servers that are no longer configured. */
	async function closeUnconfigured(configured: Record<string, ServerConfig>): Promise<void> {
		for (const [name, connection] of connections) {
			if (configured[name]) continue;
			connections.delete(name);
			await connection.client.close().catch(() => {});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// A single session rebuild can emit `session_start` more than once.
		if (sessionStarted) return;
		sessionStarted = true;

		const config = loadMcpConfig();
		if (!config) {
			await closeUnconfigured({});
			return;
		}
		await closeUnconfigured(config.servers);

		for (const [name, serverConfig] of Object.entries(config.servers)) {
			const existing = connections.get(name);
			if (existing?.connected && sameConfig(existing.config, serverConfig)) {
				// Reuse the live connection: re-register its tools and stay silent.
				registerServerTools(existing);
				continue;
			}
			if (existing) {
				connections.delete(name);
				await existing.client.close().catch(() => {});
			}
			await connectServer(name, serverConfig, ctx);
		}
	});

	pi.on("session_shutdown", async () => {
		// Connections are kept alive on purpose: the process is usually reused for
		// the next conversation, and reconnecting costs seconds. Only the tool
		// registrations die with the runtime.
		registeredToolNames.clear();
		sessionStarted = false;
	});

	pi.registerCommand("mcp", {
		description: "List connected MCP servers and their tools",
		handler: async (_args, ctx) => {
			if (connections.size === 0) {
				ctx.ui.notify("No MCP servers configured", "info");
				return;
			}
			const lines: string[] = [];
			for (const state of connections.values()) {
				lines.push(
					state.connected
						? `✓ ${state.name} — ${state.tools.length} tool(s)`
						: `✗ ${state.name} — ${state.error ?? "not connected"}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
