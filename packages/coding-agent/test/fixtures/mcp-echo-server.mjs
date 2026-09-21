// Minimal MCP stdio server used by mcp-client.test.ts.
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, no dependencies. `tools/list`
// is paged: the first call returns one tool plus a `nextCursor`, the call with
// that cursor returns the second tool.

import { writeFileSync } from "node:fs";

if (process.env.MCP_ECHO_PID_FILE) {
	writeFileSync(process.env.MCP_ECHO_PID_FILE, String(process.pid));
}

const TOOLS = [
	{
		name: "echo",
		description: "Echo the arguments back as text.",
		inputSchema: { type: "object", properties: { message: { type: "string" } } },
	},
	{
		name: "reverse",
		description: "Reverse a string.",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
];

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
	const { id, method, params } = message;
	// Notifications carry no id and get no reply.
	if (id === undefined || id === null) return;

	switch (method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "mcp-echo", version: "0.0.1" },
				},
			});
			return;
		case "tools/list":
			send({
				jsonrpc: "2.0",
				id,
				result:
					params?.cursor === "page-2"
						? { tools: [TOOLS[1]] }
						: { tools: [TOOLS[0]], nextCursor: "page-2" },
			});
			return;
		case "tools/call":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: JSON.stringify(params?.arguments ?? {}) }],
					isError: false,
				},
			});
			return;
		case "resources/read":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					contents: [{ uri: params?.uri, mimeType: "text/plain", text: `contents of ${params?.uri}` }],
				},
			});
			return;
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line) handle(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});
// Exit when the client closes our stdin.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
