import { existsSync } from "node:fs";
import type {
	AgentState,
	ConversationBootstrap,
	ConversationDetail,
	ConversationSummary,
	CreateConversationOptions,
	DesktopAgentEvent,
	InstalledSkill,
	SkillDiagnostic,
	SkillListResult,
} from "../shared/ipc.ts";
import { type AgentImage, AgentProcess, type AgentProcessEvent } from "./agent-process.ts";
import { ConversationStore, type SessionEntryRecord } from "./conversation-store.ts";

interface ConversationServiceOptions {
	agent?: AgentProcess;
	agentCliPath: () => string;
	emit: (event: DesktopAgentEvent) => void;
	freeChatCwd: string;
	mcpExtensionPath: () => string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readAgentState(value: unknown): AgentState {
	if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.thinkingLevel !== "string") {
		throw new Error("Agent returned invalid state");
	}
	const model =
		isRecord(value.model) && typeof value.model.id === "string" && typeof value.model.provider === "string"
			? { id: value.model.id, provider: value.model.provider }
			: undefined;
	return {
		isStreaming: value.isStreaming === true,
		sessionId: value.sessionId,
		sessionName: typeof value.sessionName === "string" ? value.sessionName : undefined,
		thinkingLevel: value.thinkingLevel,
		model,
	};
}

function normalizeEntries(entries: Array<Record<string, unknown>>): SessionEntryRecord[] {
	return entries.filter(
		(entry): entry is SessionEntryRecord =>
			typeof entry.id === "string" &&
			typeof entry.type === "string" &&
			typeof entry.timestamp === "string" &&
			(entry.parentId === null || typeof entry.parentId === "string"),
	);
}

function readSkills(value: unknown): SkillListResult {
	if (!isRecord(value) || !Array.isArray(value.skills) || !Array.isArray(value.diagnostics)) {
		throw new Error("Agent returned invalid skills");
	}
	const skills = value.skills.map((skill): InstalledSkill => {
		if (
			!isRecord(skill) ||
			typeof skill.name !== "string" ||
			typeof skill.description !== "string" ||
			typeof skill.filePath !== "string" ||
			typeof skill.source !== "string" ||
			typeof skill.disableModelInvocation !== "boolean" ||
			(skill.scope !== "user" && skill.scope !== "project" && skill.scope !== "temporary")
		) {
			throw new Error("Agent returned an invalid skill");
		}
		return {
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
			name: skill.name,
			path: skill.filePath,
			scope: skill.scope === "user" ? "personal" : skill.scope,
			source: skill.source,
		};
	});
	const diagnostics = value.diagnostics.map((diagnostic): SkillDiagnostic => {
		if (
			!isRecord(diagnostic) ||
			typeof diagnostic.message !== "string" ||
			(diagnostic.path !== undefined && typeof diagnostic.path !== "string") ||
			(diagnostic.type !== "warning" && diagnostic.type !== "error" && diagnostic.type !== "collision")
		) {
			throw new Error("Agent returned an invalid skill diagnostic");
		}
		return {
			message: diagnostic.message,
			path: diagnostic.path,
			type: diagnostic.type,
		};
	});
	return { diagnostics, skills };
}

export class ConversationService {
	private readonly agent: AgentProcess;
	private readonly options: ConversationServiceOptions;
	private readonly store = new ConversationStore();
	private readonly trustedProjectPaths = new Set<string>();
	private activeConversationId: string | undefined;
	private activeRunId: string | undefined;
	private abortRequested = false;
	private agentRuntimeKey: string | undefined;
	private initialized = false;

	constructor(options: ConversationServiceOptions) {
		this.options = options;
		this.agent = options.agent ?? new AgentProcess();
		this.agent.onEvent((event) => this.handleAgentEvent(event));
	}

	async bootstrap(options: CreateConversationOptions): Promise<ConversationBootstrap> {
		if (!this.initialized) {
			this.store.recoverInterruptedRuns();
			this.store.importLegacySessions({
				freeChatCwd: this.options.freeChatCwd,
				model: options.model,
				provider: options.provider,
			});
			this.initialized = true;
		}

		const conversations = this.store.listConversations();
		const lastConversationId = this.store.getLastConversationId();
		const target = conversations.find((conversation) => conversation.id === lastConversationId) ?? conversations[0];
		const conversation = target ? this.store.getConversation(target.id) : this.store.createConversation(options);
		const agentState = await this.openAgentConversation(conversation);
		return { agentState, conversation, conversations: this.store.listConversations() };
	}

	listConversations(): ConversationSummary[] {
		return this.store.listConversations();
	}

	async listSkills(): Promise<SkillListResult> {
		return readSkills(await this.agent.getSkills());
	}

	async refreshSkills(): Promise<SkillListResult> {
		this.assertIdle();
		await this.agent.reloadResources();
		return this.listSkills();
	}

	async createConversation(options: CreateConversationOptions): Promise<ConversationDetail> {
		this.assertIdle();
		if (options.project && !this.trustedProjectPaths.has(options.project.path)) {
			throw new Error("项目目录没有经过用户选择");
		}
		const conversation = this.store.createConversation(options);
		await this.openAgentConversation(conversation);
		this.emitListChanged();
		return conversation;
	}

	async openConversation(conversationId: string): Promise<ConversationDetail> {
		this.assertIdle();
		const conversation = this.store.getConversation(conversationId);
		await this.openAgentConversation(conversation);
		return conversation;
	}

	trustProject(projectPath: string): void {
		this.trustedProjectPaths.add(projectPath);
	}

	async send(conversationId: string, message: string, displayMessage: string, images: AgentImage[]): Promise<void> {
		if (conversationId !== this.activeConversationId) throw new Error("只能向当前对话发送消息");
		this.assertIdle();
		const runId = this.store.startRun(conversationId);
		this.activeRunId = runId;
		this.abortRequested = false;
		this.emitListChanged();
		try {
			await this.agent.prompt(message, images);
			const entries = normalizeEntries(await this.agent.getEntries());
			this.store.syncEntries(conversationId, entries, displayMessage);
			this.emitListChanged();
		} catch (error) {
			this.store.finishRun(runId, "failed", error instanceof Error ? error.message : String(error));
			this.activeRunId = undefined;
			this.emitListChanged();
			throw error;
		}
	}

	async abort(): Promise<void> {
		if (!this.activeRunId) return;
		this.abortRequested = true;
		await this.agent.abort();
	}

	renameConversation(conversationId: string, title: string): ConversationSummary[] {
		this.store.renameConversation(conversationId, title);
		return this.store.listConversations();
	}

	setConversationPinned(conversationId: string, pinned: boolean): ConversationSummary[] {
		this.store.setConversationPinned(conversationId, pinned);
		return this.store.listConversations();
	}

	archiveConversation(conversationId: string): ConversationSummary[] {
		if (conversationId === this.activeConversationId) throw new Error("请先切换到其他对话再归档");
		this.store.archiveConversation(conversationId);
		return this.store.listConversations();
	}

	deleteConversation(conversationId: string): ConversationSummary[] {
		if (conversationId === this.activeConversationId) throw new Error("请先切换到其他对话再删除");
		this.store.deleteConversation(conversationId);
		return this.store.listConversations();
	}

	async stop(): Promise<void> {
		if (this.activeRunId) this.store.interruptRun(this.activeRunId, "Desktop closed while the agent was running");
		this.activeRunId = undefined;
		this.agentRuntimeKey = undefined;
		await this.agent.stop();
	}

	close(): void {
		this.store.close();
	}

	private async openAgentConversation(conversation: ConversationDetail): Promise<AgentState> {
		const projectPath = conversation.project?.path;
		const cwd = projectPath && existsSync(projectPath) ? projectPath : this.options.freeChatCwd;
		const projectTrusted =
			projectPath !== undefined && cwd === projectPath && this.trustedProjectPaths.has(projectPath);
		const mcpExtension = this.options.mcpExtensionPath();
		const runtimeOptions = {
			approved: projectTrusted,
			cliPath: this.options.agentCliPath(),
			cwd,
			extensions: mcpExtension ? [mcpExtension] : undefined,
			model: conversation.model,
			provider: conversation.provider,
			toolsEnabled: projectTrusted,
		};
		const runtimeKey = JSON.stringify(runtimeOptions);
		if (!this.agent.isRunning() || runtimeKey !== this.agentRuntimeKey) {
			await this.agent.start(runtimeOptions);
			this.agentRuntimeKey = runtimeKey;
		}
		const state = await this.agent.loadSession(cwd, conversation.id, this.store.getSessionEntries(conversation.id));
		this.activeConversationId = conversation.id;
		this.store.setLastConversationId(conversation.id);
		return readAgentState(state);
	}

	private handleAgentEvent(event: AgentProcessEvent): void {
		const conversationId = this.activeConversationId;
		if (!conversationId) return;
		const runId = this.activeRunId;
		this.options.emit({ ...event, conversationId, ...(runId ? { runId } : {}) });

		if (event.type === "agent_settled" && runId) {
			void this.settleRun(conversationId, runId);
		}
		if (event.type === "desktop_process_exit" && runId) {
			this.store.interruptRun(runId, typeof event.message === "string" ? event.message : undefined);
			this.activeRunId = undefined;
			this.emitListChanged();
		}
	}

	private async settleRun(conversationId: string, runId: string): Promise<void> {
		if (this.activeRunId !== runId) return;
		try {
			const entries = normalizeEntries(await this.agent.getEntries());
			this.store.syncEntries(conversationId, entries);
			this.store.finishRun(runId, this.abortRequested ? "aborted" : "completed");
		} catch (error) {
			this.store.finishRun(runId, "failed", error instanceof Error ? error.message : String(error));
			this.options.emit({
				type: "desktop_persistence_error",
				conversationId,
				runId,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.activeRunId = undefined;
			this.abortRequested = false;
			this.emitListChanged();
		}
	}

	private assertIdle(): void {
		if (this.activeRunId) throw new Error("当前对话仍在生成，请等待完成或先停止");
	}

	private emitListChanged(): void {
		this.options.emit({ type: "conversation_list_changed", conversationId: this.activeConversationId });
	}
}
