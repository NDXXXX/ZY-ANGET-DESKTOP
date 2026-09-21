/**
 * Read-only health check for a configured MCP server.
 *
 * This is deliberately a *probe*, not a client: it runs `initialize`,
 * `notifications/initialized` and `tools/list`, counts the tools it finds, and
 * closes the connection. It never calls a tool. The real MCP client lives in
 * the coding-agent extension (`packages/coding-agent/examples/extensions/mcp`),
 * which is what the agent process uses.
 *
 * The point of the probe is to answer "is this plugin actually usable?" without
 * starting a conversation, and to turn a failure into a reason the user can act
 * on ("找不到命令 npx", "地址不存在"), instead of a silent "已安装".
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { McpHttpServer, McpProbeResult, McpServerConfig, McpStdioServer } from "../shared/ipc.ts";

const PROBE_TIMEOUT_MS = 20_000;
const PROTOCOL_VERSION = "2025-03-26";
const MAX_TOOL_PAGES = 5;

class ProbeFailure extends Error {
	readonly detail?: string;
	readonly hint?: string;

	constructor(message: string, options?: { detail?: string; hint?: string }) {
		super(message);
		this.detail = options?.detail;
		this.hint = options?.hint;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function countTools(result: unknown): number {
	if (!isRecord(result) || !Array.isArray(result.tools)) return 0;
	return result.tools.filter((tool) => isRecord(tool) && typeof tool.name === "string").length;
}

function nextCursor(result: unknown): string | undefined {
	if (!isRecord(result) || typeof result.nextCursor !== "string" || !result.nextCursor) return undefined;
	return result.nextCursor;
}

function rpcError(message: Record<string, unknown>): ProbeFailure {
	const error = isRecord(message.error) ? message.error : undefined;
	const text = typeof error?.message === "string" ? error.message : "MCP 服务器返回了错误";
	return new ProbeFailure(text, { hint: "这是服务器返回的原始错误，可对照其文档检查配置。" });
}

/** Counts tools across pages, so a paginating server does not look like it has fewer. */
async function countToolsPaged(request: (params: Record<string, unknown>) => Promise<unknown>): Promise<number> {
	let cursor: string | undefined;
	let total = 0;
	for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
		const result = await request(cursor ? { cursor } : {});
		total += countTools(result);
		cursor = nextCursor(result);
		if (!cursor) break;
	}
	return total;
}

interface StdioChannel {
	notify(method: string, params?: Record<string, unknown>): void;
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

function createStdioChannel(child: ChildProcessWithoutNullStreams): StdioChannel {
	const decoder = new StringDecoder("utf8");
	const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();
	let nextId = 1;
	let buffer = "";

	const settleLine = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.id !== "number") return;
		const entry = pending.get(parsed.id);
		if (!entry) return;
		pending.delete(parsed.id);
		if (parsed.error !== undefined) entry.reject(rpcError(parsed));
		else entry.resolve(parsed.result);
	};

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line) settleLine(line);
			newline = buffer.indexOf("\n");
		}
	});

	return {
		notify(method, params) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		},
		request(method, params) {
			const id = nextId++;
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { reject, resolve });
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
					if (!error) return;
					pending.delete(id);
					reject(error);
				});
			});
		},
	};
}

function probeStdio(config: McpStdioServer, timeoutMs: number): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(config.command, config.args ?? [], {
				env: { ...process.env, ...config.env },
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			reject(new ProbeFailure(`无法启动：${error instanceof Error ? error.message : String(error)}`));
			return;
		}

		let stderr = "";
		let settled = false;
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
		});

		const finish = (error?: Error, toolCount?: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
			if (error) reject(error);
			else resolve(toolCount ?? 0);
		};

		const timer = setTimeout(() => {
			finish(
				new ProbeFailure(`连接超时（${timeoutMs / 1000} 秒）`, {
					detail: stderr.trim() || undefined,
					hint: "首次安装某个插件时它可能需要下载依赖，会比较慢。可以先在终端里手动运行一次同样的命令完成下载。",
				}),
			);
		}, timeoutMs);

		child.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				finish(
					new ProbeFailure(`找不到命令 ${config.command}`, {
						hint: "请确认已安装 Node.js（npx 随 Node 一起提供）。如果 DDClaw 是从访达或 Dock 启动的，它可能读不到终端里的 PATH。",
					}),
				);
				return;
			}
			finish(new ProbeFailure(`无法启动：${error.message}`));
		});

		child.once("exit", (code) => {
			finish(
				new ProbeFailure(`服务器进程已退出（退出码 ${code ?? "未知"}）`, {
					detail: stderr.trim() || undefined,
					hint: "可以在终端里手动运行同样的命令，查看它输出的错误。",
				}),
			);
		});

		const channel = createStdioChannel(child);
		void (async () => {
			await channel.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "ddclaw-probe", version: "1.0.0" },
			});
			channel.notify("notifications/initialized");
			const total = await countToolsPaged((params) => channel.request("tools/list", params));
			finish(undefined, total);
		})().catch((error: unknown) => {
			if (error instanceof ProbeFailure) finish(error);
			else finish(new ProbeFailure(error instanceof Error ? error.message : String(error)));
		});
	});
}

/** Splits complete SSE events out of an incrementally decoded buffer. */
function drainSseEvents(buffer: string): { events: string[]; rest: string } {
	const events: string[] = [];
	let rest = buffer;
	for (;;) {
		const match = /\r\n\r\n|\n\n|\r\r/.exec(rest);
		if (!match) break;
		events.push(rest.slice(0, match.index));
		rest = rest.slice(match.index + match[0].length);
	}
	return { events, rest };
}

function sseEventData(event: string): string {
	return event
		.split(/\r\n|\n|\r/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).replace(/^ /, ""))
		.join("\n");
}

/** Waits for the JSON-RPC message with `id`, reading the SSE stream incrementally. */
async function readResponse(response: Response, id: number): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		const text = await response.text();
		if (!text.trim()) throw new ProbeFailure("服务器返回了空响应");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new ProbeFailure("服务器返回的不是合法 JSON");
		}
		if (isRecord(parsed) && parsed.error !== undefined) throw rpcError(parsed);
		return isRecord(parsed) ? parsed.result : undefined;
	}

	const reader = response.body?.getReader();
	if (!reader) throw new ProbeFailure("服务器没有返回响应内容");
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) throw new ProbeFailure("连接在收到响应前被关闭");
			buffer += decoder.write(value);
			const { events, rest } = drainSseEvents(buffer);
			buffer = rest;
			for (const event of events) {
				const data = sseEventData(event);
				if (!data) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(data);
				} catch {
					continue;
				}
				// The stream may carry notifications; wait for the matching reply.
				if (!isRecord(parsed) || parsed.id !== id) continue;
				if (parsed.error !== undefined) throw rpcError(parsed);
				return parsed.result;
			}
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
}

async function probeHttp(config: McpHttpServer, signal: AbortSignal): Promise<number> {
	let sessionId: string | undefined;
	let nextId = 1;

	const post = async (method: string, params: Record<string, unknown>, expectReply: boolean): Promise<unknown> => {
		const id = nextId++;
		let response: Response;
		try {
			response = await fetch(config.url, {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					...config.headers,
					...(sessionId ? { "mcp-session-id": sessionId } : {}),
				},
				body: JSON.stringify(
					expectReply ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params },
				),
				signal,
			});
		} catch (error) {
			if (signal.aborted) throw new ProbeFailure(`连接超时（${PROBE_TIMEOUT_MS / 1000} 秒）`);
			throw new ProbeFailure("无法连接该地址", { detail: error instanceof Error ? error.message : String(error) });
		}

		const newSessionId = response.headers.get("mcp-session-id");
		if (newSessionId) sessionId = newSessionId;

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				throw new ProbeFailure(`服务器要求授权（HTTP ${response.status}）`, {
					hint: "请检查该插件的访问令牌是否填写正确、是否已过期。",
				});
			}
			if (response.status === 404) {
				throw new ProbeFailure("地址不存在（HTTP 404）", {
					hint: "请确认 URL 是否正确，有些服务器要求以 /mcp 结尾。",
				});
			}
			throw new ProbeFailure(`服务器返回 HTTP ${response.status}`);
		}

		if (!expectReply) return undefined;
		return readResponse(response, id);
	};

	await post(
		"initialize",
		{ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ddclaw-probe", version: "1.0.0" } },
		true,
	);
	await post("notifications/initialized", {}, false);
	return countToolsPaged((params) => post("tools/list", params, true));
}

export async function probeMcpServer(config: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
	try {
		const toolCount =
			config.type === "stdio"
				? await probeStdio(config, timeoutMs)
				: await probeHttp(config, AbortSignal.timeout(timeoutMs));
		return { status: "ready", toolCount };
	} catch (error) {
		if (error instanceof ProbeFailure) {
			return { status: "error", message: error.message, detail: error.detail, hint: error.hint };
		}
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

export async function probeMcpServers(
	servers: Record<string, McpServerConfig>,
	names: string[],
): Promise<Record<string, McpProbeResult>> {
	const entries = await Promise.all(
		names.map(async (name): Promise<[string, McpProbeResult]> => {
			const config = servers[name];
			if (!config) return [name, { status: "error", message: "配置里找不到这个插件" }];
			return [name, await probeMcpServer(config)];
		}),
	);
	return Object.fromEntries(entries);
}
