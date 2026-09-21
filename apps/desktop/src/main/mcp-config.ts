import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpConfigProblem, McpListResult, McpServers } from "../shared/ipc.ts";
import { isRecord, normalizeServer, parseMcpServers } from "../shared/mcp.ts";

// Mirrors the coding-agent extension's config location (`getAgentDir()` +
// "mcp-servers.json") so the GUI edits the same file the agent reads.
const CONFIG_DIR_NAME = ".pi";
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_FILE_NAME = "mcp-servers.json";

function expandTildePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

export function resolveConfigPath(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	const agentDir = envDir ? expandTildePath(envDir) : join(homedir(), CONFIG_DIR_NAME, "agent");
	return join(agentDir, CONFIG_FILE_NAME);
}

function resolveBackupPath(): string {
	return `${resolveConfigPath()}.bak`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Reads and parses a config file. Returns undefined when it is unreadable or meaningless. */
function readServersFrom(filePath: string): McpServers | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		return parseMcpServers(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** True for a file that parses and simply holds no servers, e.g. `{}` or `{"mcpServers":{}}`. */
function isEmptyConfig(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 0) return true;
	if (keys.length > 1) return false;
	const [key] = keys;
	if (key !== "mcpServers" && key !== "servers") return false;
	const map = value[key];
	return isRecord(map) && Object.keys(map).length === 0;
}

export function readMcpServers(): McpListResult {
	const configPath = resolveConfigPath();

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A missing file is simply "nothing configured yet".
		if (code === "ENOENT") return { servers: {} };
		return { problem: problem(`无法读取配置文件：${errorMessage(error)}`), servers: {} };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { problem: problem(`配置文件不是合法 JSON：${errorMessage(error)}`), servers: {} };
	}

	const servers = parseMcpServers(parsed);
	if (!servers && !isEmptyConfig(parsed)) {
		return { problem: problem("配置文件里没有能识别的 MCP 服务器，可能被改坏了"), servers: {} };
	}
	return { servers: servers ?? {} };
}

function problem(message: string): McpConfigProblem {
	return { backupAvailable: existsSync(resolveBackupPath()), message, path: resolveConfigPath() };
}

function assertWritable(servers: McpServers): void {
	for (const [name, definition] of Object.entries(servers)) {
		if (!name.trim() || !normalizeServer(definition)) throw new Error(`MCP 服务器 "${name}" 配置无效`);
	}
	// Saving over an unparsable file would destroy whatever the user had; they
	// must restore the backup or fix the file first.
	const current = readMcpServers();
	if (current.problem) throw new Error(`${current.problem.message}，请先修复或恢复备份再保存`);
}

function writeConfig(servers: McpServers): void {
	const configPath = resolveConfigPath();
	mkdirSync(dirname(configPath), { recursive: true });

	// `mcpServers` is the key every other MCP client uses, so the file can be
	// copied into (or out of) Claude Desktop, Cursor and VS Code unchanged.
	const contents = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
	const tempPath = `${configPath}.tmp`;
	writeFileSync(tempPath, contents);
	// Rename is atomic on the same filesystem, so a crash mid-write cannot leave
	// a half-written config behind.
	renameSync(tempPath, configPath);
}

export function writeMcpServers(servers: McpServers): void {
	assertWritable(servers);

	const configPath = resolveConfigPath();
	// Keep the last known-good config so a bad edit can be rolled back.
	if (existsSync(configPath) && readServersFrom(configPath)) {
		copyFileSync(configPath, resolveBackupPath());
	}
	writeConfig(servers);
}

/** Restores `mcp-servers.json` from its `.bak`, used when the config is corrupt. */
export function restoreMcpBackup(): McpListResult {
	const backupPath = resolveBackupPath();
	const backup = readServersFrom(backupPath);
	if (!backup) throw new Error("没有可用的备份文件");
	writeConfig(backup);
	return readMcpServers();
}
