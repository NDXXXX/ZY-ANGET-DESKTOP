export type ThemeMode = "auto" | "light" | "dark";

export interface SelectedProject {
	name: string;
	path: string;
}

export interface SelectedAttachment {
	kind: "image" | "text";
	name: string;
	path: string;
	size: number;
}

export interface AgentState {
	isStreaming: boolean;
	model?: {
		id: string;
		provider: string;
	};
	sessionId: string;
	sessionName?: string;
	thinkingLevel: string;
}

export type ConversationStatus = "idle" | "running" | "interrupted" | "error";

export interface ConversationMessage {
	content: string;
	createdAt: number;
	id: string;
	role: "assistant" | "system" | "user";
}

export interface ConversationSummary {
	archivedAt?: number;
	createdAt: number;
	id: string;
	lastMessagePreview?: string;
	model: string;
	pinnedAt?: number;
	project?: SelectedProject;
	provider: string;
	status: ConversationStatus;
	title: string;
	updatedAt: number;
}

export interface ConversationDetail extends ConversationSummary {
	messages: ConversationMessage[];
	transcriptId: string;
}

export interface ConversationBootstrap {
	agentState: AgentState;
	conversation: ConversationDetail;
	conversations: ConversationSummary[];
}

export interface CreateConversationOptions {
	model: string;
	project?: SelectedProject;
	provider: string;
}

export interface McpStdioServer {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface McpHttpServer {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;
export type McpServers = Record<string, McpServerConfig>;

/**
 * Result of a read-only health check against one MCP server. A probe only runs
 * `initialize` and `tools/list`; it never calls tools.
 */
export interface McpProbeResult {
	status: "ready" | "error";
	toolCount?: number;
	/** One-line, user-facing reason for a failure. */
	message?: string;
	/** Raw stderr or protocol detail, shown in the diagnostics section. */
	detail?: string;
	/** Actionable next step. */
	hint?: string;
}

/** Set when mcp-servers.json exists but cannot be parsed. */
export interface McpConfigProblem {
	backupAvailable: boolean;
	message: string;
	path: string;
}

export interface McpListResult {
	problem?: McpConfigProblem;
	servers: McpServers;
}

export interface McpMutationResult extends McpListResult {
	names: string[];
}

export type InstalledSkillScope = "personal" | "project" | "temporary";

export interface InstalledSkill {
	description: string;
	disableModelInvocation: boolean;
	name: string;
	path: string;
	scope: InstalledSkillScope;
	source: string;
}

export interface SkillDiagnostic {
	message: string;
	path?: string;
	type: "warning" | "error" | "collision";
}

export interface SkillListResult {
	diagnostics: SkillDiagnostic[];
	skills: InstalledSkill[];
}

export interface DesktopAgentEvent {
	conversationId?: string;
	runId?: string;
	type: string;
	[key: string]: unknown;
}

export interface PiDesktopBridge {
	abortAgent(): Promise<void>;
	archiveConversation(conversationId: string): Promise<ConversationSummary[]>;
	bootstrapConversations(options: CreateConversationOptions): Promise<ConversationBootstrap>;
	cancelMcpProbe(name: string): Promise<void>;
	closeWindow(): Promise<void>;
	createConversation(options: CreateConversationOptions): Promise<ConversationDetail>;
	deleteConversation(conversationId: string): Promise<ConversationSummary[]>;
	listConversations(): Promise<ConversationSummary[]>;
	listMcpServers(): Promise<McpListResult>;
	listSkills(): Promise<SkillListResult>;
	refreshSkills(): Promise<SkillListResult>;
	addCustomMcpServers(servers: McpServers): Promise<McpMutationResult>;
	installBuiltinPlugin(id: string, configuration?: Record<string, string>): Promise<McpMutationResult>;
	minimizeWindow(): Promise<void>;
	onAgentEvent(listener: (event: DesktopAgentEvent) => void): () => void;
	openConversation(conversationId: string): Promise<ConversationDetail>;
	probeMcpServer(name: string): Promise<McpProbeResult>;
	renameConversation(conversationId: string, title: string): Promise<ConversationSummary[]>;
	restoreMcpBackup(): Promise<McpListResult>;
	revealMcpConfig(): Promise<void>;
	revealSkillsDirectory(): Promise<void>;
	removeMcpServer(name: string): Promise<McpListResult>;
	selectAttachments(): Promise<SelectedAttachment[]>;
	selectDirectory(): Promise<string | null>;
	selectProject(): Promise<SelectedProject | null>;
	sendPrompt(
		conversationId: string,
		message: string,
		displayMessage: string,
		attachments: SelectedAttachment[],
	): Promise<void>;
	setConversationPinned(conversationId: string, pinned: boolean): Promise<ConversationSummary[]>;
	stopAgent(): Promise<void>;
	toggleMaximizeWindow(): Promise<void>;
}

export const IPC_CHANNELS = {
	agentAbort: "agent:abort",
	agentEvent: "agent:event",
	agentPrompt: "agent:prompt",
	agentStop: "agent:stop",
	attachmentSelect: "attachment:select",
	conversationArchive: "conversation:archive",
	conversationBootstrap: "conversation:bootstrap",
	conversationCreate: "conversation:create",
	conversationDelete: "conversation:delete",
	conversationList: "conversation:list",
	conversationOpen: "conversation:open",
	conversationPin: "conversation:pin",
	conversationRename: "conversation:rename",
	mcpList: "mcp:list",
	mcpAddCustom: "mcp:add-custom",
	mcpCancelTest: "mcp:cancel-test",
	mcpInstallBuiltin: "mcp:install-builtin",
	mcpRemove: "mcp:remove",
	mcpRestore: "mcp:restore",
	mcpReveal: "mcp:reveal",
	mcpSelectDirectory: "mcp:select-directory",
	mcpTest: "mcp:test",
	skillList: "skill:list",
	skillRefresh: "skill:refresh",
	skillReveal: "skill:reveal",
	projectSelect: "project:select",
	windowClose: "window:close",
	windowMinimize: "window:minimize",
	windowToggleMaximize: "window:toggle-maximize",
} as const;
