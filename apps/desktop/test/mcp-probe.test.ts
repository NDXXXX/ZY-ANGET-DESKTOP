import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeMcpServer } from "../src/main/mcp-probe.ts";

const echoServer = fileURLToPath(
	new URL("../../../packages/coding-agent/test/fixtures/mcp-echo-server.mjs", import.meta.url),
);

interface StubServer {
	close: () => Promise<void>;
	requests: string[];
	url: string;
}

const servers: StubServer[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
});

/** Loopback MCP server; `handle` receives the parsed JSON-RPC message. */
async function startServer(
	handle: (message: Record<string, unknown>, request: IncomingMessage, response: ServerResponse) => void,
): Promise<StubServer> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			const message = JSON.parse(body || "{}") as Record<string, unknown>;
			requests.push(`${String(message.method)} ${request.headers["mcp-session-id"] ?? "-"}`);
			handle(message, request, response);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const stub: StubServer = {
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		requests,
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
	};
	servers.push(stub);
	return stub;
}

function initialize(message: Record<string, unknown>, response: ServerResponse, sessionId?: string): void {
	if (sessionId) response.setHeader("mcp-session-id", sessionId);
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result: { protocolVersion: "2025-03-26" } }));
}

describe("probeMcpServer", () => {
	it("counts tools across pages of a stdio server", async () => {
		// The fixture splits its two tools over two pages.
		const result = await probeMcpServer({
			type: "stdio",
			command: process.execPath,
			args: [echoServer],
		});

		expect(result).toEqual({ status: "ready", toolCount: 2 });
	});

	it("explains a command it cannot find", async () => {
		const result = await probeMcpServer({ type: "stdio", command: "ddclaw-no-such-binary", args: [] });

		expect(result.status).toBe("error");
		expect(result.message).toContain("找不到命令 ddclaw-no-such-binary");
		expect(result.hint).toContain("PATH");
	});

	it("reads an SSE response that stays open, page by page", async () => {
		const pages = [[{ name: "first" }], [{ name: "second" }]];
		const server = await startServer((message, _request, response) => {
			if (message.method === "initialize") {
				initialize(message, response, "session-1");
				return;
			}
			if (message.method === "notifications/initialized") {
				response.statusCode = 202;
				response.end();
				return;
			}

			const params = message.params as { cursor?: string } | undefined;
			const page = pages[params?.cursor ? 1 : 0];
			const frame = `event: message\ndata: ${JSON.stringify({
				id: message.id,
				jsonrpc: "2.0",
				result: { tools: page, ...(params?.cursor ? {} : { nextCursor: "page-2" }) },
			})}\n\n`;
			// The server-to-client stream never ends, so the probe has to stop at
			// the frame carrying its own id. Writing in two halves makes sure a
			// frame split across chunks is still parsed.
			response.writeHead(200, { "content-type": "text/event-stream" });
			const half = Math.floor(frame.length / 2);
			response.write(frame.slice(0, half));
			setTimeout(() => response.write(frame.slice(half)), 20);
		});

		const result = await probeMcpServer({ type: "http", url: server.url });

		expect(result).toEqual({ status: "ready", toolCount: 2 });
		// The session id from `initialize` is echoed on the later requests.
		expect(server.requests).toEqual([
			"initialize -",
			"notifications/initialized session-1",
			"tools/list session-1",
			"tools/list session-1",
		]);
	});

	it("reads a plain JSON response", async () => {
		const server = await startServer((message, _request, response) => {
			if (message.method === "initialize") {
				initialize(message, response);
				return;
			}
			if (message.method === "notifications/initialized") {
				response.statusCode = 202;
				response.end();
				return;
			}
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ id: message.id, jsonrpc: "2.0", result: { tools: [{ name: "only" }] } }));
		});

		const result = await probeMcpServer({ type: "http", url: server.url });

		expect(result).toEqual({ status: "ready", toolCount: 1 });
	});

	it("points at the URL when the server answers 404", async () => {
		const server = await startServer((_message, _request, response) => {
			response.statusCode = 404;
			response.end();
		});

		const result = await probeMcpServer({ type: "http", url: server.url });

		expect(result.message).toContain("地址不存在");
		expect(result.hint).toContain("/mcp");
	});

	it("reports a server that wants authorization", async () => {
		const server = await startServer((_message, _request, response) => {
			response.statusCode = 401;
			response.end();
		});

		const result = await probeMcpServer({ type: "http", url: server.url });

		expect(result.message).toContain("服务器要求授权");
		expect(result.hint).toContain("令牌");
	});
});
