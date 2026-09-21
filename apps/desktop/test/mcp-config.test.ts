import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServers } from "../src/shared/ipc.ts";
import {
	addMcpServers,
	readMcpServers,
	removeMcpServer,
	restoreMcpBackup,
	writeMcpServers,
} from "../src/main/mcp-config.ts";

const filesystemServer: McpServers = {
	filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
};

const docsServer: McpServers = {
	context7: { type: "http", url: "https://mcp.context7.com/mcp", headers: { "X-Api-Key": "secret" } },
};

describe("mcp-config", () => {
	let directory: string;
	let configPath: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		directory = join(tmpdir(), `ddclaw-mcp-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = directory;
		configPath = join(directory, "mcp-servers.json");
	});

	afterEach(() => {
		rmSync(directory, { force: true, recursive: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("treats a missing file as an empty configuration", () => {
		expect(readMcpServers()).toEqual({ servers: {} });
	});

	it("round-trips servers through the shared mcpServers key", () => {
		writeMcpServers(docsServer);

		expect(readMcpServers().servers).toEqual(docsServer);
		// Other MCP clients read this key, so configs stay copy-pasteable.
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ mcpServers: docsServer });
	});

	it("writes atomically, leaving no temporary file behind", () => {
		writeMcpServers(filesystemServer);

		expect(readdirSync(directory)).toEqual(["mcp-servers.json"]);
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});

	it("adds servers to the latest config and resolves name conflicts", () => {
		writeMcpServers(filesystemServer);

		const result = addMcpServers({ filesystem: docsServer.context7 });

		expect(result.names).toEqual(["filesystem-2"]);
		expect(result.servers).toEqual({ ...filesystemServer, "filesystem-2": docsServer.context7 });
	});

	it("removes only the requested server from the latest config", () => {
		writeMcpServers({ ...filesystemServer, ...docsServer });

		const result = removeMcpServer("filesystem");

		expect(result).toEqual({ servers: docsServer });
	});

	it("treats an explicitly empty server map as configured", () => {
		writeFileSync(configPath, '{ "mcpServers": {} }');
		expect(readMcpServers()).toEqual({ servers: {} });
	});

	it("reports an unreadable file instead of pretending it is empty", () => {
		writeFileSync(configPath, "{ not json");

		const result = readMcpServers();
		expect(result.servers).toEqual({});
		expect(result.problem?.path).toBe(configPath);
		expect(result.problem?.backupAvailable).toBe(false);
	});

	it("refuses to save over a file it could not parse", () => {
		writeFileSync(configPath, "{ not json");

		expect(() => writeMcpServers(docsServer)).toThrow(/请先修复或恢复备份/);
		// The user's file must survive a save it never agreed to.
		expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
	});

	it("rejects a server definition it cannot run", () => {
		expect(() => writeMcpServers({ broken: { type: "stdio" } })).toThrow(/配置无效/);
		expect(existsSync(configPath)).toBe(false);
	});

	it("accepts the ecosystem format without an explicit type", () => {
		const withoutType = { fetch: { command: "uvx", args: ["mcp-server-fetch"] } };
		writeFileSync(configPath, JSON.stringify(withoutType));

		expect(readMcpServers()).toEqual({ servers: { fetch: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] } } });
	});

	it("backs up the previous config and restores it", () => {
		writeMcpServers(filesystemServer);
		writeMcpServers(docsServer);

		expect(JSON.parse(readFileSync(`${configPath}.bak`, "utf-8"))).toEqual({ mcpServers: filesystemServer });

		writeFileSync(configPath, "{{{");
		const broken = readMcpServers();
		expect(broken.problem?.backupAvailable).toBe(true);

		expect(restoreMcpBackup()).toEqual({ servers: filesystemServer });
		expect(readMcpServers()).toEqual({ servers: filesystemServer });
	});

	it("fails loudly when there is no backup to restore", () => {
		expect(() => restoreMcpBackup()).toThrow(/没有可用的备份/);
	});
});
