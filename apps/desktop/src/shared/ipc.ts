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
	closeWindow(): Promise<void>;
	createConversation(options: CreateConversationOptions): Promise<ConversationDetail>;
	deleteConversation(conversationId: string): Promise<ConversationSummary[]>;
	listConversations(): Promise<ConversationSummary[]>;
	minimizeWindow(): Promise<void>;
	onAgentEvent(listener: (event: DesktopAgentEvent) => void): () => void;
	openConversation(conversationId: string): Promise<ConversationDetail>;
	renameConversation(conversationId: string, title: string): Promise<ConversationSummary[]>;
	selectAttachments(): Promise<SelectedAttachment[]>;
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
	projectSelect: "project:select",
	windowClose: "window:close",
	windowMinimize: "window:minimize",
	windowToggleMaximize: "window:toggle-maximize",
} as const;
