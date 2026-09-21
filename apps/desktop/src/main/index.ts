import { existsSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
	type CreateConversationOptions,
	IPC_CHANNELS,
	type McpServers,
	type SelectedAttachment,
	type SelectedProject,
} from "../shared/ipc.ts";
import type { AgentImage } from "./agent-process.ts";
import { ConversationService } from "./conversation-service.ts";
import { readMcpServers, resolveConfigPath, restoreMcpBackup, writeMcpServers } from "./mcp-config.ts";
import { probeMcpServers } from "./mcp-probe.ts";
import { ensurePersonalSkillsDirectory, listInstalledSkills } from "./skill-config.ts";

// Electron's macOS GPU compositor can leave the frameless window black or
// display stale surfaces from other apps. Software compositing is more stable
// for this mostly static desktop UI and must be enabled before `ready`.
if (process.platform === "darwin") app.disableHardwareAcceleration();

const appIconPath = join(app.getAppPath(), "resources/app-icon.png");
const selectedAttachmentPaths = new Set<string>();
let conversationService: ConversationService | undefined;
let mainWindow: BrowserWindow | undefined;
let selectedProjectPath: string | undefined;

const imageMimeTypes: Readonly<Record<string, string>> = {
	".bmp": "image/bmp",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

const maxAttachmentCount = 10;
const maxImageBytes = 10 * 1024 * 1024;
const maxTextBytes = 1024 * 1024;

function findAgentCli(): string {
	const appPath = app.getAppPath();
	const candidates = [
		process.env.PI_DESKTOP_AGENT_CLI,
		resolve(appPath, "../../packages/coding-agent/dist/bundle/cli.js"),
		resolve(process.cwd(), "packages/coding-agent/dist/bundle/cli.js"),
		resolve(process.cwd(), "../../packages/coding-agent/dist/bundle/cli.js"),
	].filter((candidate): candidate is string => Boolean(candidate));

	const cliPath = candidates.find((candidate) => existsSync(candidate));
	if (!cliPath) throw new Error("找不到 Pi Agent 构建产物。请先在仓库根目录运行 npm run build。");
	return cliPath;
}

function findMcpExtension(): string | undefined {
	const appPath = app.getAppPath();
	const candidates = [
		process.env.PI_DESKTOP_MCP_EXTENSION,
		resolve(appPath, "../../packages/coding-agent/examples/extensions/mcp/index.ts"),
		resolve(process.cwd(), "packages/coding-agent/examples/extensions/mcp/index.ts"),
		resolve(process.cwd(), "../../packages/coding-agent/examples/extensions/mcp/index.ts"),
	].filter((candidate): candidate is string => Boolean(candidate));

	return candidates.find((candidate) => existsSync(candidate));
}

function getConversationService(): ConversationService {
	if (!conversationService) throw new Error("对话服务尚未就绪");
	return conversationService;
}

function validateProject(project: SelectedProject): void {
	if (project.path !== selectedProjectPath) throw new Error("项目目录没有经过用户选择");
	if (!existsSync(project.path) || !statSync(project.path).isDirectory()) throw new Error("项目目录不存在");
}

function validateCreateOptions(options: CreateConversationOptions): void {
	if (!options || typeof options.provider !== "string" || typeof options.model !== "string") {
		throw new Error("对话配置不正确");
	}
	if (options.project) validateProject(options.project);
}

function attachmentKind(filePath: string): SelectedAttachment["kind"] {
	return imageMimeTypes[extname(filePath).toLowerCase()] ? "image" : "text";
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

async function preparePrompt(
	message: string,
	attachments: SelectedAttachment[],
): Promise<{ images: AgentImage[]; message: string }> {
	let prompt = message.trim();
	const images: AgentImage[] = [];

	for (const attachment of attachments) {
		if (!attachment || typeof attachment.path !== "string" || !selectedAttachmentPaths.has(attachment.path)) {
			throw new Error("附件没有经过用户选择");
		}

		const filePath = attachment.path;
		const content = await readFile(filePath);
		const mimeType = imageMimeTypes[extname(filePath).toLowerCase()];
		if (mimeType) {
			images.push({ data: content.toString("base64"), mimeType, type: "image" });
			prompt += `\n<file name="${escapeAttribute(filePath)}"></file>`;
			continue;
		}
		if (content.includes(0)) throw new Error(`暂不支持二进制文件：${basename(filePath)}`);
		prompt += `\n<file name="${escapeAttribute(filePath)}">\n${content.toString("utf8")}\n</file>`;
	}

	return { images, message: prompt.trim() };
}

function registerIpcHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.attachmentSelect, async () => {
		const window = mainWindow;
		if (!window) throw new Error("桌面窗口尚未就绪");
		const selection = await dialog.showOpenDialog(window, {
			buttonLabel: "添加",
			properties: ["openFile", "multiSelections"],
			title: "选择要发送给 DDClaw 的文件",
		});
		if (selection.canceled) return [];
		if (selection.filePaths.length > maxAttachmentCount) {
			throw new Error(`每次最多添加 ${maxAttachmentCount} 个文件`);
		}

		return Promise.all(
			selection.filePaths.map(async (filePath): Promise<SelectedAttachment> => {
				const fileStats = await stat(filePath);
				if (!fileStats.isFile()) throw new Error(`${basename(filePath)} 不是文件`);
				const kind = attachmentKind(filePath);
				const sizeLimit = kind === "image" ? maxImageBytes : maxTextBytes;
				if (fileStats.size > sizeLimit) {
					throw new Error(`${basename(filePath)} 太大，${kind === "image" ? "图片" : "文本"}附件超过限制`);
				}
				selectedAttachmentPaths.add(filePath);
				return { kind, name: basename(filePath), path: filePath, size: fileStats.size };
			}),
		);
	});

	ipcMain.handle(IPC_CHANNELS.projectSelect, async () => {
		const window = mainWindow;
		if (!window) throw new Error("桌面窗口尚未就绪");
		const selection = await dialog.showOpenDialog(window, {
			buttonLabel: "打开项目",
			properties: ["openDirectory"],
			title: "选择 DDClaw 要操作的项目目录",
		});
		if (selection.canceled || !selection.filePaths[0]) return null;

		const projectPath = selection.filePaths[0];
		const trust = await dialog.showMessageBox(window, {
			buttons: ["信任并打开", "取消"],
			cancelId: 1,
			defaultId: 0,
			detail: "信任后，DDClaw 可以加载项目内的设置、Skills、Prompts 和 Extensions，并使用文件与命令工具。",
			message: `是否信任项目 ${basename(projectPath)}？`,
			type: "question",
		});
		if (trust.response !== 0) return null;

		selectedProjectPath = projectPath;
		getConversationService().trustProject(projectPath);
		return { name: basename(projectPath), path: projectPath };
	});

	ipcMain.handle(IPC_CHANNELS.conversationBootstrap, async (_event, options: CreateConversationOptions) => {
		validateCreateOptions(options);
		return getConversationService().bootstrap(options);
	});
	ipcMain.handle(IPC_CHANNELS.conversationList, () => getConversationService().listConversations());
	ipcMain.handle(IPC_CHANNELS.conversationCreate, async (_event, options: CreateConversationOptions) => {
		validateCreateOptions(options);
		return getConversationService().createConversation(options);
	});
	ipcMain.handle(IPC_CHANNELS.conversationOpen, (_event, conversationId: string) =>
		getConversationService().openConversation(conversationId),
	);
	ipcMain.handle(IPC_CHANNELS.conversationRename, (_event, conversationId: string, title: string) =>
		getConversationService().renameConversation(conversationId, title),
	);
	ipcMain.handle(IPC_CHANNELS.mcpList, () => readMcpServers());
	ipcMain.handle(IPC_CHANNELS.mcpSave, (_event, servers: McpServers) => {
		writeMcpServers(servers);
	});
	ipcMain.handle(IPC_CHANNELS.mcpProbe, (_event, names: string[]) => {
		const { servers } = readMcpServers();
		const requested = Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
		return probeMcpServers(servers, requested);
	});
	ipcMain.handle(IPC_CHANNELS.mcpRestore, () => restoreMcpBackup());
	ipcMain.handle(IPC_CHANNELS.mcpReveal, async () => {
		const configPath = resolveConfigPath();
		if (existsSync(configPath)) shell.showItemInFolder(configPath);
		else await shell.openPath(dirname(configPath));
	});
	ipcMain.handle(IPC_CHANNELS.mcpSelectDirectory, async () => {
		const window = mainWindow;
		if (!window) throw new Error("桌面窗口尚未就绪");
		const selection = await dialog.showOpenDialog(window, {
			buttonLabel: "授权",
			properties: ["openDirectory"],
			title: "选择要授权给 Agent 的目录",
		});
		return selection.canceled ? null : (selection.filePaths[0] ?? null);
	});
	ipcMain.handle(IPC_CHANNELS.skillList, () => listInstalledSkills(selectedProjectPath));
	ipcMain.handle(IPC_CHANNELS.skillReveal, async () => {
		await shell.openPath(ensurePersonalSkillsDirectory());
	});
	ipcMain.handle(IPC_CHANNELS.conversationPin, (_event, conversationId: string, pinned: boolean) =>
		getConversationService().setConversationPinned(conversationId, pinned),
	);
	ipcMain.handle(IPC_CHANNELS.conversationArchive, (_event, conversationId: string) =>
		getConversationService().archiveConversation(conversationId),
	);
	ipcMain.handle(IPC_CHANNELS.conversationDelete, (_event, conversationId: string) =>
		getConversationService().deleteConversation(conversationId),
	);
	ipcMain.handle(
		IPC_CHANNELS.agentPrompt,
		async (
			_event,
			conversationId: string,
			message: string,
			displayMessage: string,
			attachments: SelectedAttachment[],
		) => {
			if (!Array.isArray(attachments)) throw new Error("附件格式不正确");
			const prepared = await preparePrompt(message, attachments);
			if (!prepared.message && prepared.images.length === 0) throw new Error("消息不能为空");
			await getConversationService().send(conversationId, prepared.message, displayMessage, prepared.images);
			for (const attachment of attachments) selectedAttachmentPaths.delete(attachment.path);
		},
	);
	ipcMain.handle(IPC_CHANNELS.agentAbort, () => getConversationService().abort());
	ipcMain.handle(IPC_CHANNELS.agentStop, () => getConversationService().stop());
	ipcMain.handle(IPC_CHANNELS.windowClose, () => mainWindow?.close());
	ipcMain.handle(IPC_CHANNELS.windowMinimize, () => mainWindow?.minimize());
	ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, () => {
		if (mainWindow?.isMaximized()) mainWindow.unmaximize();
		else mainWindow?.maximize();
	});
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		backgroundColor: "#000000",
		frame: false,
		height: 900,
		icon: appIconPath,
		minHeight: 640,
		minWidth: 900,
		show: true,
		title: "DDClaw",
		width: 1440,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: join(__dirname, "../preload/index.cjs"),
			sandbox: true,
		},
	});

	mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
	mainWindow.webContents.once("did-finish-load", () => {
		mainWindow?.show();
		app.focus({ steal: true });
		mainWindow?.focus();
	});
	const devServerUrl = process.env.PI_DESKTOP_DEV_SERVER_URL;
	if (devServerUrl) void mainWindow.loadURL(devServerUrl);
	else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
	if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
	conversationService = new ConversationService({
		agentCliPath: findAgentCli,
		emit: (event) => mainWindow?.webContents.send(IPC_CHANNELS.agentEvent, event),
		freeChatCwd: app.getPath("userData"),
		mcpExtensionPath: findMcpExtension,
	});
	registerIpcHandlers();
	createWindow();
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	void conversationService?.stop();
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	void conversationService?.stop().finally(() => conversationService?.close());
});
