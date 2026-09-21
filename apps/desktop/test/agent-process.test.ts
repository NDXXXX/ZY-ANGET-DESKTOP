import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProcess } from "../src/main/agent-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/agent-rpc.mjs", import.meta.url));

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("AgentProcess", () => {
	let directory: string | undefined;
	const originalPidFile = process.env.PI_AGENT_TEST_PID_FILE;
	const originalIgnoreShutdown = process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN;

	afterEach(() => {
		if (originalPidFile === undefined) delete process.env.PI_AGENT_TEST_PID_FILE;
		else process.env.PI_AGENT_TEST_PID_FILE = originalPidFile;
		if (originalIgnoreShutdown === undefined) delete process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN;
		else process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN = originalIgnoreShutdown;
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("waits for a cooperative process to exit", async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-agent-process-"));
		const pidFile = join(directory, "pid");
		process.env.PI_AGENT_TEST_PID_FILE = pidFile;
		delete process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN;
		const agent = new AgentProcess(100);

		await agent.start({
			approved: false,
			cliPath: fixture,
			cwd: directory,
			model: "test",
			provider: "test",
			toolsEnabled: false,
		});
		expect(await agent.getSkills()).toEqual({ diagnostics: [], skills: [] });
		const pid = Number(readFileSync(pidFile, "utf8"));
		await agent.stop();

		expect(agent.isRunning()).toBe(false);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it("force-kills a process that ignores SIGTERM and stdin close", async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-agent-stubborn-"));
		const pidFile = join(directory, "pid");
		process.env.PI_AGENT_TEST_PID_FILE = pidFile;
		process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN = "1";
		const agent = new AgentProcess(50);

		await agent.start({
			approved: false,
			cliPath: fixture,
			cwd: directory,
			model: "test",
			provider: "test",
			toolsEnabled: false,
		});
		const pid = Number(readFileSync(pidFile, "utf8"));
		await agent.stop();

		expect(agent.isRunning()).toBe(false);
		expect(isProcessAlive(pid)).toBe(false);
	});
});
