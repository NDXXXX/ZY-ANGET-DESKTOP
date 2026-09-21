import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import {
	type CreateConversationOptions,
	type DesktopAgentEvent,
	IPC_CHANNELS,
	type McpServers,
	type PiDesktopBridge,
	type SelectedAttachment,
} from "../shared/ipc.ts";

const bridge: PiDesktopBridge = {
	abortAgent: () => ipcRenderer.invoke(IPC_CHANNELS.agentAbort),
	archiveConversation: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.conversationArchive, conversationId),
	bootstrapConversations: (options: CreateConversationOptions) =>
		ipcRenderer.invoke(IPC_CHANNELS.conversationBootstrap, options),
	closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowClose),
	createConversation: (options: CreateConversationOptions) =>
		ipcRenderer.invoke(IPC_CHANNELS.conversationCreate, options),
	deleteConversation: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.conversationDelete, conversationId),
	listConversations: () => ipcRenderer.invoke(IPC_CHANNELS.conversationList),
	listMcpServers: () => ipcRenderer.invoke(IPC_CHANNELS.mcpList),
	listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.skillList),
	minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowMinimize),
	onAgentEvent: (listener) => {
		const handler = (_event: IpcRendererEvent, agentEvent: DesktopAgentEvent) => listener(agentEvent);
		ipcRenderer.on(IPC_CHANNELS.agentEvent, handler);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler);
	},
	openConversation: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.conversationOpen, conversationId),
	probeMcpServers: (names: string[]) => ipcRenderer.invoke(IPC_CHANNELS.mcpProbe, names),
	renameConversation: (conversationId, title) =>
		ipcRenderer.invoke(IPC_CHANNELS.conversationRename, conversationId, title),
	restoreMcpBackup: () => ipcRenderer.invoke(IPC_CHANNELS.mcpRestore),
	revealMcpConfig: () => ipcRenderer.invoke(IPC_CHANNELS.mcpReveal),
	revealSkillsDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.skillReveal),
	saveMcpServers: (servers: McpServers) => ipcRenderer.invoke(IPC_CHANNELS.mcpSave, servers),
	selectAttachments: () => ipcRenderer.invoke(IPC_CHANNELS.attachmentSelect),
	selectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.mcpSelectDirectory),
	selectProject: () => ipcRenderer.invoke(IPC_CHANNELS.projectSelect),
	sendPrompt: (conversationId: string, message: string, displayMessage: string, attachments: SelectedAttachment[]) =>
		ipcRenderer.invoke(IPC_CHANNELS.agentPrompt, conversationId, message, displayMessage, attachments),
	setConversationPinned: (conversationId, pinned) =>
		ipcRenderer.invoke(IPC_CHANNELS.conversationPin, conversationId, pinned),
	stopAgent: () => ipcRenderer.invoke(IPC_CHANNELS.agentStop),
	toggleMaximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.windowToggleMaximize),
};

contextBridge.exposeInMainWorld("piDesktop", bridge);
