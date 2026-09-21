import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, SseParser } from "../examples/extensions/mcp/mcp-client.ts";

const echoServerFixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));
const SESSION_ID = "test-session-1";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("SseParser", () => {
	it("emits a frame split across chunks exactly once, when it completes", () => {
		const parser = new SseParser();
		expect(parser.push('data: {"jsonrpc":"2.0",')).toEqual([]);
		expect(parser.push('"id":1,"result"')).toEqual([]);
		expect(parser.push(":{}}\n\n")).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
		expect(parser.push("")).toEqual([]);
	});

	it("joins multiple data lines with newlines", () => {
		const parser = new SseParser();
		expect(parser.push("data: first\ndata: second\ndata:\n\n")).toEqual(["first\nsecond\n"]);
	});

	it("ignores comment lines", () => {
		const parser = new SseParser();
		expect(parser.push(": keep-alive\n:data: not data\ndata: real\n\n")).toEqual(["real"]);
	});

	it("accepts CRLF, lone CR and mixed line endings", () => {
		const parser = new SseParser();
		expect(parser.push("data: crlf\r\n\r\n")).toEqual(["crlf"]);
		expect(parser.push("data: cr\r\r")).toEqual(["cr"]);
		expect(parser.push("data: a\r\ndata: b\n\r\ndata: c\r\r")).toEqual(["a\nb", "c"]);
	});

	it("treats a trailing CR as a line ending and swallows the LF that follows", () => {
		const parser = new SseParser();
		expect(parser.push("data: split\r")).toEqual([]);
		// The LF belongs to the CRLF already consumed, it is not a blank line.
		expect(parser.push("\n")).toEqual([]);
		expect(parser.push("\n")).toEqual(["split"]);
	});

	it("drops events whose type is not message", () => {
		const parser = new SseParser();
		expect(parser.push("event: ping\ndata: ignored\n\n")).toEqual([]);
		expect(parser.push("event: message\ndata: kept\n\n")).toEqual(["kept"]);
		expect(parser.push("data: no type\n\n")).toEqual(["no type"]);
	});

	it("dispatches several events from a single chunk, in order", () => {
		const parser = new SseParser();
		expect(parser.push('data: {"id":1}\n\ndata: {"id":2}\n\n')).toEqual(['{"id":1}', '{"id":2}']);
	});

	it("strips at most one space after the colon", () => {
		const parser = new SseParser();
		expect(parser.push("data: one\n\n")).toEqual(["one"]);
		expect(parser.push("data:  two\n\n")).toEqual([" two"]);
		expect(parser.push("data:three\n\n")).toEqual(["three"]);
	});

	it("dispatches an event with an empty data value, and ignores unknown fields", () => {
		const parser = new SseParser();
		expect(parser.push("id: 42\nretry: 100\nunknown: x\ndata:\n\n")).toEqual([""]);
		// A lone `event:` line without data dispatches nothing.
		expect(parser.push("event: message\n\n")).toEqual([]);
	});

	it("ignores an unterminated trailing frame until the blank line arrives", () => {
		const parser = new SseParser();
		expect(parser.push("data: pending\n")).toEqual([]);
		expect(parser.push("\n")).toEqual(["pending"]);
	});
});

/** A loopback HTTP server that records the JSON-RPC requests it receives. */
interface RecordedRequest {
	method: string;
	id: unknown;
	params: Record<string, unknown>;
	sessionId?: string;
}

interface TestServer {
	url: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

function startServer(
	handle: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
	return new Promise((resolve) => {
		const requests: RecordedRequest[] = [];
		const server = createServer((request, response) => {
			// The client cancels the event stream mid-flight, so late writes can fail.
			response.on("error", () => {});
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(chunk as Buffer);
				const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					method: string;
					id?: unknown;
					params?: Record<string, unknown>;
				};
				const recorded: RecordedRequest = {
					method: message.method,
					id: message.id,
					params: message.params ?? {},
					sessionId: headerValue(request.headers["mcp-session-id"]),
				};
				requests.push(recorded);
				await handle(recorded, response);
			})().catch(() => {});
		});
		server.on("clientError", (_error, socket) => socket.destroy());
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				requests,
				close: () =>
					new Promise<void>((done) => {
						// Streams are never ended, so the sockets have to be torn down.
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}

/**
 * Write an SSE frame in two halves with a pause in between, and never end the
 * response: this is what a streamable-HTTP MCP server does.
 */
async function writeSplitEvent(response: ServerResponse, payload: unknown): Promise<void> {
	const frame = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	const cut = Math.floor(frame.length / 2);
	response.write(frame.slice(0, cut));
	await delay(25);
	response.write(frame.slice(cut));
}

describe("HttpTransport", () => {
	let server: TestServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	it("resolves against a server that holds the event stream open", async () => {
		const httpServer = await startServer(async (request, response) => {
			if (request.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": SESSION_ID });
			const result =
				request.method === "initialize"
					? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "sse", version: "1" } }
					: { tools: [{ name: "streamed", description: "Tool from an open stream." }] };
			await writeSplitEvent(response, { jsonrpc: "2.0", id: request.id, result });
		});
		server = httpServer;

		const client = createMcpClient({ type: "http", url: httpServer.url });
		await client.connect();

		await expect(client.listTools()).resolves.toEqual([
			{ name: "streamed", description: "Tool from an open stream.", inputSchema: undefined },
		]);

		// The session header from the first response is echoed on later requests,
		// including the initialization notification.
		expect(httpServer.requests.map((request) => request.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		expect(httpServer.requests[1]?.sessionId).toBe(SESSION_ID);
		expect(httpServer.requests[2]?.sessionId).toBe(SESSION_ID);
	});

	it("rejects when the stream ends without a matching response", async () => {
		const httpServer = await startServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			// Someone else's id, then the stream closes.
			response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} })}\n\n`);
		});
		server = httpServer;

		const client = createMcpClient({ type: "http", url: httpServer.url });
		await expect(client.listTools()).rejects.toThrow(/closed the stream before responding to tools\/list/);
	});

	it("follows tools/list pagination and de-duplicates tools", async () => {
		const httpServer = await startServer((request, response) => {
			const tools =
				request.params.cursor === "page-2"
					? [
							{ name: "alpha", description: "First tool." },
							{ name: "beta", description: "Second tool." },
						]
					: [{ name: "alpha", description: "First tool." }];
			const result: Record<string, unknown> = { tools };
			if (request.params.cursor !== "page-2") result.nextCursor = "page-2";
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
		});
		server = httpServer;

		const client = createMcpClient({ type: "http", url: httpServer.url });
		const tools = await client.listTools();

		expect(tools).toEqual([
			{ name: "alpha", description: "First tool.", inputSchema: undefined },
			{ name: "beta", description: "Second tool.", inputSchema: undefined },
		]);
		expect(httpServer.requests.map((request) => request.params)).toEqual([{}, { cursor: "page-2" }]);
	});

	it("gives up on a server that never stops handing out cursors", async () => {
		const httpServer = await startServer((request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: { tools: [{ name: "looping" }], nextCursor: "again" },
				}),
			);
		});
		server = httpServer;

		const client = createMcpClient({ type: "http", url: httpServer.url });
		// Bounded by MCP_MAX_TOOL_PAGES (50); without a cap this never returns.
		await expect(client.listTools()).resolves.toEqual([
			{ name: "looping", description: undefined, inputSchema: undefined },
		]);
		expect(httpServer.requests).toHaveLength(50);
	});
});

describe("StdioTransport", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("converses with a stdio server across pages", async () => {
		const client = createMcpClient({ type: "stdio", command: process.execPath, args: [echoServerFixture] });
		try {
			await client.connect();

			expect((await client.listTools()).map((tool) => tool.name)).toEqual(["echo", "reverse"]);

			const call = await client.callTool("echo", { message: "hello" });
			expect(call.isError).toBe(false);
			expect(call.content).toEqual([{ type: "text", text: '{"message":"hello"}' }]);

			const contents = await client.readResource("file:///notes.txt");
			expect(contents[0]?.text).toBe("contents of file:///notes.txt");
		} finally {
			await client.close();
		}
	});

	it("close() terminates the server process", async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-mcp-echo-"));
		const pidFile = join(directory, "pid");
		const client = createMcpClient({
			type: "stdio",
			command: process.execPath,
			args: [echoServerFixture],
			env: { MCP_ECHO_PID_FILE: pidFile },
		});

		await client.connect();
		await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(isProcessAlive(pid)).toBe(true);

		await client.close();

		await expect.poll(() => isProcessAlive(pid), { timeout: 5000 }).toBe(false);
		await expect(client.listTools()).rejects.toThrow("MCP server is not running");
	});
});
