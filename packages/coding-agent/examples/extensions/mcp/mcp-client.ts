/**
 * Minimal MCP (Model Context Protocol) client.
 *
 * Hand-rolled JSON-RPC 2.0 over two transports:
 *   - stdio: a spawned subprocess exchanging newline-delimited JSON on stdin/stdout
 *   - http:   the streamable HTTP transport (POST JSON-RPC, JSON or SSE response)
 *
 * No external dependencies. Only the subset of MCP needed to list and call tools
 * (plus read resources) is implemented.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { HttpServerConfig, ServerConfig, StdioServerConfig } from "./config.ts";

const MCP_PROTOCOL_VERSION = "2025-03-26";

/** Upper bound on `tools/list` pages followed, so a buggy server cannot loop forever. */
const MCP_MAX_TOOL_PAGES = 50;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface McpCallResult {
	content: McpContent[];
	isError: boolean;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface Transport {
	request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
	notify(method: string, params?: unknown): Promise<void>;
	close(): Promise<void>;
	/** Synchronous, best-effort termination for `process.on("exit")`, where nothing can be awaited. */
	kill(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function responsePayload(message: Record<string, unknown>): unknown {
	if (message.error !== undefined) {
		const error = message.error as { message?: unknown };
		throw new Error(typeof error.message === "string" ? error.message : "MCP JSON-RPC error");
	}
	return message.result;
}

/**
 * Incremental parser for the WHATWG server-sent events wire format.
 *
 * Feed it text as it is decoded off the wire; `push` returns the data payload of
 * every complete event that is ready. Only `message` events (the default type,
 * i.e. no `event:` field or `event: message`) are dispatched; comments and other
 * event types are parsed and dropped exactly like an `EventSource` listener for
 * "message" would ignore them.
 *
 * Pure: no I/O, no timers.
 */
export class SseParser {
	private buffer = "";
	private eventType = "";
	private dataLines: string[] = [];
	private crPending = false;

	/** Feed a chunk of decoded text; returns the data payloads of the events it completed. */
	push(chunk: string): string[] {
		// The previous chunk ended on a CR, so a leading LF here belongs to that
		// CRLF and must not be mistaken for a line ending of its own.
		if (this.crPending && chunk.startsWith("\n")) chunk = chunk.slice(1);
		this.crPending = false;
		this.buffer += chunk;
		const events: string[] = [];
		for (;;) {
			const line = this.shiftLine();
			if (line === undefined) return events;
			const data = this.handleLine(line);
			if (data !== undefined) events.push(data);
		}
	}

	/** Take one complete line off the buffer. Accepts LF, CRLF and lone CR, mixed freely. */
	private shiftLine(): string | undefined {
		for (let index = 0; index < this.buffer.length; index++) {
			const char = this.buffer[index];
			if (char === "\n") {
				const line = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + 1);
				return line;
			}
			if (char === "\r") {
				// A CR at the end of the buffer ends the line either way: on its own
				// (old Mac line ending) or as the first half of a CRLF whose LF is
				// still in flight, which the next push swallows.
				if (index === this.buffer.length - 1) {
					const line = this.buffer.slice(0, index);
					this.buffer = "";
					this.crPending = true;
					return line;
				}
				const terminatorWidth = this.buffer[index + 1] === "\n" ? 2 : 1;
				const line = this.buffer.slice(0, index);
				this.buffer = this.buffer.slice(index + terminatorWidth);
				return line;
			}
		}
		return undefined;
	}

	private handleLine(line: string): string | undefined {
		// A blank line dispatches the buffered event.
		if (line === "") return this.dispatch();
		// Lines starting with a colon are comments.
		if (line.startsWith(":")) return undefined;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		// Strip exactly one leading space after the colon, per spec.
		if (value.startsWith(" ")) value = value.slice(1);

		if (field === "event") this.eventType = value;
		else if (field === "data") this.dataLines.push(value);
		// Unknown fields (including `id` and `retry`) are ignored.
		return undefined;
	}

	private dispatch(): string | undefined {
		const lines = this.dataLines;
		this.dataLines = [];
		const type = this.eventType === "" ? "message" : this.eventType;
		this.eventType = "";
		if (lines.length === 0) return undefined;
		if (type !== "message") return undefined;
		return lines.join("\n");
	}
}

class StdioTransport implements Transport {
	private readonly proc: ChildProcessWithoutNullStreams;
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private lineBuffer = "";
	private stderr = "";
	private closed = false;

	constructor(config: StdioServerConfig) {
		this.proc = spawn(config.command, config.args ?? [], {
			env: { ...process.env, ...config.env },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.on("data", (chunk: Buffer) => this.onData(this.decoder.write(chunk)));
		this.proc.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
		});
		this.proc.once("error", () => this.onExit());
		this.proc.once("exit", () => this.onExit());
	}

	private onData(chunk: string): void {
		this.lineBuffer += chunk;
		let newline = this.lineBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
			this.lineBuffer = this.lineBuffer.slice(newline + 1);
			if (line) this.handleLine(line);
			newline = this.lineBuffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.id !== "number") return;
		const pending = this.pending.get(parsed.id);
		if (!pending) return;
		this.pending.delete(parsed.id);
		if (parsed.error !== undefined) {
			const error = parsed.error as { message?: unknown };
			pending.reject(new Error(typeof error.message === "string" ? error.message : "MCP JSON-RPC error"));
		} else {
			pending.resolve(parsed.result);
		}
	}

	private onExit(): void {
		this.closed = true;
		for (const pending of this.pending.values()) {
			pending.reject(new Error(`MCP server exited: ${this.stderr.trim() || "no stderr"}`));
		}
		this.pending.clear();
	}

	request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP server is not running"));
		const id = this.nextId++;

		return new Promise<unknown>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new Error(`MCP request ${method} was aborted`));
			};
			if (signal) {
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pending.set(id, { resolve, reject });
			this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (writeError) => {
				if (!writeError) return;
				this.pending.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(writeError);
			});

			const settle = (fn: (value: unknown | Error) => void, value: unknown | Error) => {
				signal?.removeEventListener("abort", onAbort);
				fn(value as never);
			};
			this.pending.set(id, {
				resolve: (value) => settle(resolve, value),
				reject: (error) => settle(reject, error),
			});
		});
	}

	async notify(method: string, params?: unknown): Promise<void> {
		if (this.closed) return;
		this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const proc = this.proc;
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, 5000);
	}

	kill(): void {
		if (this.closed) return;
		this.closed = true;
		// SIGTERM rather than SIGKILL: with `npx -y <pkg>` the child is npx, which
		// has to shut its own child down for us.
		this.proc.kill("SIGTERM");
	}
}

class HttpTransport implements Transport {
	private readonly url: string;
	private readonly headers: Record<string, string>;
	private sessionId?: string;
	private nextId = 1;

	constructor(config: HttpServerConfig) {
		this.url = config.url;
		this.headers = config.headers ?? {};
	}

	private baseHeaders(): Record<string, string> {
		const headers: Record<string, string> = { ...this.headers };
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		return headers;
	}

	async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const response = await fetch(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...this.baseHeaders(),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			signal,
		});
		if (!response.ok) throw new Error(`MCP HTTP server returned ${response.status}`);

		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionId = sessionId;

		if (response.headers.get("content-type")?.includes("text/event-stream")) {
			return this.readEventStream(response, id, method);
		}

		const body = await response.text();
		if (body.trim() === "") throw new Error(`MCP HTTP server returned an empty response for ${method}`);
		const message = JSON.parse(body) as unknown;
		if (!isRecord(message) || message.id !== id) {
			throw new Error(`MCP HTTP server returned a mismatched response for ${method}`);
		}
		return responsePayload(message);
	}

	/**
	 * Read a `text/event-stream` response incrementally.
	 *
	 * MCP keeps this stream open for the lifetime of the session (it is the
	 * server-to-client channel), so the response is parsed frame by frame and the
	 * reader is cancelled as soon as the frame carrying our id shows up — waiting
	 * for the server to close would hang forever.
	 */
	private async readEventStream(response: Response, id: number, method: string): Promise<unknown> {
		const body = response.body;
		if (!body) throw new Error(`MCP HTTP server returned no response body for ${method}`);

		const reader = body.getReader();
		// Chunk boundaries can split a multi-byte character.
		const decoder = new StringDecoder("utf8");
		const parser = new SseParser();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				for (const data of parser.push(done ? decoder.end() : decoder.write(value))) {
					let message: unknown;
					try {
						message = JSON.parse(data);
					} catch {
						// Ignore malformed frames.
						continue;
					}
					if (!isRecord(message) || message.id !== id) continue;
					return responsePayload(message);
				}
				if (done) throw new Error(`MCP HTTP server closed the stream before responding to ${method}`);
			}
		} finally {
			// Runs before the returned promise settles, so a matching response
			// tears the stream down immediately instead of leaking the connection.
			await reader.cancel().catch(() => {});
		}
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await fetch(this.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.baseHeaders() },
			body: JSON.stringify({ jsonrpc: "2.0", method, params }),
		});
	}

	async close(): Promise<void> {
		this.sessionId = undefined;
	}

	kill(): void {
		// Nothing to terminate: HTTP requests die with the process.
	}
}

export class McpClient {
	private readonly transport: Transport;

	constructor(transport: Transport) {
		this.transport = transport;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		await this.transport.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi-mcp", version: "0.1.0" },
			},
			signal,
		);
		await this.transport.notify("notifications/initialized");
	}

	async listTools(signal?: AbortSignal): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;

		for (let page = 0; page < MCP_MAX_TOOL_PAGES; page++) {
			// The first page is requested with `{}`, later pages with the cursor.
			const result = await this.transport.request("tools/list", cursor === undefined ? {} : { cursor }, signal);
			if (!isRecord(result) || !Array.isArray(result.tools)) break;

			for (const entry of result.tools) {
				if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) continue;
				if (seen.has(entry.name)) continue;
				seen.add(entry.name);
				tools.push({
					name: entry.name,
					description: typeof entry.description === "string" ? entry.description : undefined,
					inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : undefined,
				});
			}

			const next = result.nextCursor;
			if (typeof next !== "string" || next.length === 0) break;
			cursor = next;
		}

		return tools;
	}

	async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
		const result = await this.transport.request("tools/call", { name, arguments: args }, signal);
		if (!isRecord(result)) return { content: [], isError: false };
		const content: McpContent[] = [];
		if (Array.isArray(result.content)) {
			for (const item of result.content) {
				if (isRecord(item)) content.push(item as unknown as McpContent);
			}
		}
		return { content, isError: result.isError === true };
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<McpContent[]> {
		const result = await this.transport.request("resources/read", { uri }, signal);
		if (!isRecord(result) || !Array.isArray(result.contents)) return [];
		const contents: McpContent[] = [];
		for (const item of result.contents) {
			if (isRecord(item)) contents.push(item as unknown as McpContent);
		}
		return contents;
	}

	async close(): Promise<void> {
		await this.transport.close();
	}

	/** Synchronous teardown for `process.on("exit")`; prefer `close()` anywhere else. */
	kill(): void {
		this.transport.kill();
	}
}

export function createMcpClient(config: ServerConfig): McpClient {
	const transport: Transport = config.type === "stdio" ? new StdioTransport(config) : new HttpTransport(config);
	return new McpClient(transport);
}
