/**
 * Connections must survive a session rebuild. `load_session` (the desktop's
 * conversation switch) tears down and recreates the runtime, so reconnecting on
 * every `session_start` restarts every MCP server — seconds per switch.
 *
 * See docs/mcp-connection-reuse-design.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-echo-server.mjs", import.meta.url));

type HookName = "session_shutdown" | "session_start";
type Hook = (event: { type: HookName }, ctx: ExtensionContext) => Promise<void> | void;

const context = { ui: { notify: () => {} } } as unknown as ExtensionContext;

interface FakePi extends ExtensionAPI {
	/** Tool names registered so far, in registration order. */
	tools: string[];
	runHooks(name: HookName): Promise<void>;
}

function createFakePi(): FakePi {
	const hooks = new Map<HookName, Hook[]>();
	const tools: string[] = [];

	return {
		tools,
		on(name: HookName, hook: Hook) {
			hooks.set(name, [...(hooks.get(name) ?? []), hook]);
		},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
		},
		async runHooks(name: HookName) {
			for (const hook of hooks.get(name) ?? []) await hook({ type: name }, context);
		},
	} as unknown as FakePi;
}

function serverConfig(pidFile: string) {
	return {
		mcpServers: {
			echo: {
				command: process.execPath,
				args: [fixture],
				env: { MCP_ECHO_PID_FILE: pidFile },
			},
		},
	};
}

function readPid(pidFile: string): number | undefined {
	if (!existsSync(pidFile)) return undefined;
	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	return Number.isNaN(pid) ? undefined : pid;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

/** Loads a fresh extension module: its connection cache is module-level state. */
async function loadExtension(): Promise<(pi: ExtensionAPI) => void> {
	vi.resetModules();
	const module = await import("../examples/extensions/mcp/index.ts");
	return module.default as (pi: ExtensionAPI) => void;
}

describe("MCP extension connection reuse", () => {
	let directory: string;
	let pidFile: string;
	const pids = new Set<number>();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousServers = process.env.PI_MCP_SERVERS;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "ddclaw-mcp-reuse-"));
		pidFile = join(directory, "server.pid");
		// Never read the user's real ~/.pi/agent/mcp-servers.json.
		process.env.PI_CODING_AGENT_DIR = directory;
	});

	afterEach(() => {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		pids.clear();
		rmSync(directory, { force: true, recursive: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousServers === undefined) delete process.env.PI_MCP_SERVERS;
		else process.env.PI_MCP_SERVERS = previousServers;
	});

	/** Starts one session and returns the pid of the fixture process it spawned. */
	async function connectOnce(pi: FakePi, pidFileToUse = pidFile): Promise<number> {
		await pi.runHooks("session_start");
		expect(await waitFor(() => readPid(pidFileToUse) !== undefined)).toBe(true);
		const pid = readPid(pidFileToUse) as number;
		pids.add(pid);
		return pid;
	}

	it("reuses the connection and re-registers the same tools for the next session", async () => {
		process.env.PI_MCP_SERVERS = JSON.stringify(serverConfig(pidFile));
		const pi = createFakePi();
		(await loadExtension())(pi);

		const pid = await connectOnce(pi);
		// `echo` + `reverse` from the fixture, plus the read_resource helper.
		const firstSessionTools = [...pi.tools];
		expect(firstSessionTools).toHaveLength(3);

		// A rebuilt runtime has an empty tool registry, so registration is per-session.
		pi.tools.length = 0;
		await pi.runHooks("session_shutdown");
		await pi.runHooks("session_start");

		expect([...pi.tools].sort()).toEqual([...firstSessionTools].sort());
		// The connection was reused: no second fixture process was spawned.
		expect(readPid(pidFile)).toBe(pid);
		expect(isAlive(pid)).toBe(true);
	});

	it("keeps the connection alive when the session ends", async () => {
		process.env.PI_MCP_SERVERS = JSON.stringify(serverConfig(pidFile));
		const pi = createFakePi();
		(await loadExtension())(pi);

		const pid = await connectOnce(pi);
		await pi.runHooks("session_shutdown");

		expect(isAlive(pid)).toBe(true);
	});

	it("reconnects when the server configuration changed", async () => {
		process.env.PI_MCP_SERVERS = JSON.stringify(serverConfig(pidFile));
		const pi = createFakePi();
		(await loadExtension())(pi);
		await connectOnce(pi);

		// Same server, different env: still a different config, so it must not be reused.
		const secondPidFile = join(directory, "server-2.pid");
		process.env.PI_MCP_SERVERS = JSON.stringify(serverConfig(secondPidFile));
		await pi.runHooks("session_shutdown");
		await pi.runHooks("session_start");

		expect(await waitFor(() => readPid(secondPidFile) !== undefined)).toBe(true);
		pids.add(readPid(secondPidFile) as number);
	});

	it("closes a connection whose server was removed from the config", async () => {
		process.env.PI_MCP_SERVERS = JSON.stringify(serverConfig(pidFile));
		const pi = createFakePi();
		(await loadExtension())(pi);
		const pid = await connectOnce(pi);

		// No env config and no config file: the server is gone from the config.
		delete process.env.PI_MCP_SERVERS;
		await pi.runHooks("session_shutdown");
		await pi.runHooks("session_start");

		expect(await waitFor(() => !isAlive(pid))).toBe(true);
	});

	it("connects at most three servers concurrently and registers tools in config order", async () => {
		const eventFile = join(directory, "events.log");
		const names = ["alpha", "beta", "gamma", "delta"];
		const mcpServers = Object.fromEntries(
			names.map((name) => [
				name,
				{
					command: process.execPath,
					args: [fixture],
					env: {
						MCP_ECHO_DELAY_MS: "200",
						MCP_ECHO_EVENT_FILE: eventFile,
						MCP_ECHO_LABEL: name,
						MCP_ECHO_PID_FILE: join(directory, `${name}.pid`),
					},
				},
			]),
		);
		process.env.PI_MCP_SERVERS = JSON.stringify({ mcpServers });
		const pi = createFakePi();
		(await loadExtension())(pi);

		await pi.runHooks("session_start");
		for (const name of names) {
			const pid = readPid(join(directory, `${name}.pid`));
			expect(pid).toBeDefined();
			pids.add(pid as number);
		}

		const events = readFileSync(eventFile, "utf8").trim().split("\n");
		const firstFinish = events.findIndex((event) => event.endsWith(":finish"));
		expect(events.slice(0, firstFinish).filter((event) => event.endsWith(":start"))).toHaveLength(3);
		expect(events.indexOf("delta:start")).toBeGreaterThan(firstFinish);
		expect(pi.tools.filter((name) => name.endsWith("_echo"))).toEqual([
			"mcp_alpha_echo",
			"mcp_beta_echo",
			"mcp_gamma_echo",
			"mcp_delta_echo",
		]);
	});
});
