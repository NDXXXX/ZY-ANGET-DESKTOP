import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentProcess, type AgentProcessOptions } from "../src/main/agent-process.ts";
import { ConversationService } from "../src/main/conversation-service.ts";

class FakeAgentProcess extends AgentProcess {
	running = false;
	startCalls: AgentProcessOptions[] = [];

	override isRunning(): boolean {
		return this.running;
	}

	override async start(options: AgentProcessOptions): Promise<unknown> {
		this.running = true;
		this.startCalls.push(options);
		return this.state();
	}

	override async loadSession(_cwd: string, sessionId: string): Promise<unknown> {
		return this.state(sessionId);
	}

	override async stop(): Promise<void> {
		this.running = false;
	}

	private state(sessionId = "session") {
		return {
			isStreaming: false,
			model: { id: "model", provider: "provider" },
			sessionId,
			thinkingLevel: "medium",
		};
	}
}

describe("ConversationService", () => {
	let directory: string;
	let service: ConversationService;
	let agent: FakeAgentProcess;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		directory = join(tmpdir(), `ddclaw-conversation-service-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = directory;
		agent = new FakeAgentProcess();
		service = new ConversationService({
			agent,
			agentCliPath: () => "/fake/cli.js",
			emit: () => {},
			freeChatCwd: directory,
			mcpExtensionPath: () => "/fake/mcp.ts",
		});
	});

	afterEach(() => {
		service.close();
		rmSync(directory, { force: true, recursive: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("reuses the Agent process when creating another conversation in the same runtime", async () => {
		await service.createConversation({ model: "model", provider: "provider" });
		await service.createConversation({ model: "model", provider: "provider" });

		expect(agent.startCalls).toHaveLength(1);
	});

	it("restarts the Agent process when the runtime changes", async () => {
		await service.createConversation({ model: "model", provider: "provider" });
		await service.createConversation({ model: "other-model", provider: "provider" });

		expect(agent.startCalls).toHaveLength(2);
	});
});
