import {
	type FormEvent,
	type KeyboardEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	AgentState,
	ConversationMessage,
	ConversationSummary,
	DesktopAgentEvent,
	SelectedAttachment,
	SelectedProject,
	ThemeMode,
} from "../../shared/ipc.ts";
import { McpPanel } from "./McpPanel.tsx";

interface ChatMessage extends ConversationMessage {
	streaming?: boolean;
}

interface ConversationMenuState {
	conversation: ConversationSummary;
	x: number;
	y: number;
}

type WorkspaceView = "chat" | "plugins";

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 420;
const COLLAPSED_TOOLBAR_WIDTH = 224;

function clampSidebarWidth(width: number): number {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function readSidebarWidth(): number {
	const saved = Number(localStorage.getItem("pi-desktop-sidebar-width"));
	return Number.isFinite(saved) ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function resolveTheme(mode: ThemeMode, date = new Date()): "dark" | "light" {
	if (mode !== "auto") return mode;
	const hour = date.getHours();
	return hour >= 7 && hour < 18 ? "light" : "dark";
}

function readThemeMode(): ThemeMode {
	const saved = localStorage.getItem("pi-desktop-theme");
	return saved === "light" || saved === "dark" ? saved : "auto";
}

function textFromMessage(value: unknown): string {
	if (!isRecord(value)) return "";
	const content = value.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
		.join("");
}

function themeLabel(mode: ThemeMode): string {
	if (mode === "auto") return "自动";
	return mode === "light" ? "白天" : "夜间";
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
	if (mode === "light") {
		return (
			<svg aria-hidden="true" viewBox="0 0 24 24">
				<circle cx="12" cy="12" r="3.5" />
				<path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
			</svg>
		);
	}
	if (mode === "dark") {
		return (
			<svg aria-hidden="true" viewBox="0 0 24 24">
				<path d="M20.4 15.3A8.5 8.5 0 0 1 8.7 3.6 8.5 8.5 0 1 0 20.4 15.3Z" />
			</svg>
		);
	}
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<circle cx="12" cy="12" r="8" />
			<path d="M12 4a8 8 0 0 0 0 16Z" className="theme-icon-fill" />
		</svg>
	);
}

type IconName =
	| "add"
	| "attachment"
	| "back"
	| "close"
	| "chevron-down"
	| "explore"
	| "forward"
	| "folder"
	| "image"
	| "microphone"
	| "plugin"
	| "schedule"
	| "send"
	| "sidebar"
	| "stop";

function Icon({ name }: { name: IconName }) {
	if (name === "add") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="M12 5v14M5 12h14" />
			</svg>
		);
	}
	if (name === "attachment") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="m8.5 12.5 6.1-6.1a3.2 3.2 0 1 1 4.5 4.5l-8 8a5 5 0 0 1-7.1-7.1l8.2-8.2" />
			</svg>
		);
	}
	if (name === "back") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="m14 5-7 7 7 7M7 12h13" />
			</svg>
		);
	}
	if (name === "image") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<rect height="17" rx="3" width="19" x="2.5" y="3.5" />
				<circle cx="8" cy="9" r="1.5" />
				<path d="m4.5 17 4.5-4.5 3.2 3.2 2.2-2.2 4.9 4.9" />
			</svg>
		);
	}
	if (name === "schedule") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<circle cx="12" cy="12" r="9" />
				<path d="M12 7v5l3 2" />
			</svg>
		);
	}
	if (name === "plugin") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="M8.5 4.5a3 3 0 1 1 5.6 1.5H18a2 2 0 0 1 2 2v3.9a3 3 0 1 0 0 5.6V19a2 2 0 0 1-2 2h-4.4a3 3 0 1 0-5.6 0H6a2 2 0 0 1-2-2v-4.4a3 3 0 1 0 0-5.6V8a2 2 0 0 1 2-2h4.1a3 3 0 0 1-1.6-1.5Z" />
			</svg>
		);
	}
	if (name === "explore") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
				<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
				<circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
			</svg>
		);
	}
	if (name === "forward") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="m10 5 7 7-7 7M17 12H4" />
			</svg>
		);
	}
	if (name === "close") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="m7 7 10 10M17 7 7 17" />
			</svg>
		);
	}
	if (name === "chevron-down") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="m6 9 6 6 6-6" />
			</svg>
		);
	}
	if (name === "folder") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="M3.5 7.5h6l2-2h9v13h-17Z" />
			</svg>
		);
	}
	if (name === "send") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
			</svg>
		);
	}
	if (name === "microphone") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<rect height="11" rx="4" width="6" x="9" y="3" />
				<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
			</svg>
		);
	}
	if (name === "sidebar") {
		return (
			<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
				<rect height="18" rx="2.5" width="18" x="3" y="3" />
				<path d="M9 3v18" />
			</svg>
		);
	}
	return (
		<svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
			<rect height="9" rx="1.5" width="9" x="7.5" y="7.5" />
		</svg>
	);
}

export function App() {
	const [agentState, setAgentState] = useState<AgentState>();
	const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [conversationMenu, setConversationMenu] = useState<ConversationMenuState>();
	const [error, setError] = useState<string>();
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [project, setProject] = useState<SelectedProject>();
	const [activeConversationId, setActiveConversationId] = useState<string>();
	const [starting, setStarting] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [streaming, setStreaming] = useState(false);
	const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
	const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
	const activeConversationRef = useRef<string | undefined>(undefined);
	const bootstrappedRef = useRef(false);
	const composerInputRef = useRef<HTMLTextAreaElement>(null);
	const messageEndRef = useRef<HTMLDivElement>(null);
	const sidebarResizeRef = useRef<{ startWidth: number; startX: number } | null>(null);

	const activeTheme = useMemo(() => resolveTheme(themeMode), [themeMode]);
	const pinnedConversations = conversations.filter((conversation) => conversation.pinnedAt !== undefined);
	const recentConversations = conversations.filter((conversation) => conversation.pinnedAt === undefined);

	useEffect(() => {
		activeConversationRef.current = activeConversationId;
	}, [activeConversationId]);

	useEffect(() => {
		if (!conversationMenu) return;
		const closeMenu = () => setConversationMenu(undefined);
		const closeOnEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") closeMenu();
		};
		window.addEventListener("click", closeMenu);
		window.addEventListener("blur", closeMenu);
		window.addEventListener("keydown", closeOnEscape);
		return () => {
			window.removeEventListener("click", closeMenu);
			window.removeEventListener("blur", closeMenu);
			window.removeEventListener("keydown", closeOnEscape);
		};
	}, [conversationMenu]);

	useEffect(() => {
		document.documentElement.dataset.theme = activeTheme;
		localStorage.setItem("pi-desktop-theme", themeMode);
	}, [activeTheme, themeMode]);

	useEffect(() => {
		localStorage.setItem("pi-desktop-sidebar-width", String(sidebarWidth));
	}, [sidebarWidth]);

	useEffect(() => {
		if (themeMode !== "auto") return;
		const timer = window.setInterval(() => {
			document.documentElement.dataset.theme = resolveTheme("auto");
		}, 60_000);
		return () => window.clearInterval(timer);
	}, [themeMode]);

	useEffect(() => {
		if (messages.length > 0) {
			messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
		}
	}, [messages.length]);

	useEffect(() => {
		if (workspaceView === "chat" && messages.length === 0 && agentState && !starting) {
			composerInputRef.current?.focus();
		}
	}, [agentState, messages.length, starting, workspaceView]);

	const refreshConversationList = useCallback((): void => {
		void window.piDesktop
			.listConversations()
			.then(setConversations)
			.catch((listError: unknown) => {
				setError(listError instanceof Error ? listError.message : String(listError));
			});
	}, []);

	const handleAgentEvent = useCallback(
		(event: DesktopAgentEvent): void => {
			if (event.type === "conversation_list_changed") {
				refreshConversationList();
				return;
			}
			if (event.conversationId && event.conversationId !== activeConversationRef.current) return;
			if (event.type === "agent_start") {
				setStreaming(true);
				return;
			}
			if (event.type === "agent_settled") {
				setStreaming(false);
				setMessages((current) => current.map((message) => ({ ...message, streaming: false })));
				return;
			}
			if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" && typeof update.delta === "string") {
					const delta = update.delta;
					setMessages((current) => {
						const last = current[current.length - 1];
						if (last?.role === "assistant" && last.streaming) {
							return [...current.slice(0, -1), { ...last, content: last.content + delta }];
						}
						return [
							...current,
							{
								content: delta,
								createdAt: Date.now(),
								id: crypto.randomUUID(),
								role: "assistant",
								streaming: true,
							},
						];
					});
				}
				return;
			}
			if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
				const finalText = textFromMessage(event.message);
				if (finalText) {
					setMessages((current) => {
						const last = current[current.length - 1];
						if (last?.role === "assistant" && last.streaming) {
							return [...current.slice(0, -1), { ...last, content: finalText, streaming: false }];
						}
						return [
							...current,
							{ content: finalText, createdAt: Date.now(), id: crypto.randomUUID(), role: "assistant" },
						];
					});
				}
				return;
			}
			if (event.type === "desktop_process_exit") {
				setStreaming(false);
				setError(typeof event.message === "string" ? event.message : "Agent 已停止");
				return;
			}
			if (event.type === "desktop_persistence_error") {
				setError(typeof event.message === "string" ? event.message : "保存对话失败");
			}
		},
		[refreshConversationList],
	);

	useEffect(() => {
		if (!window.piDesktop) return;
		return window.piDesktop.onAgentEvent(handleAgentEvent);
	}, [handleAgentEvent]);

	useEffect(() => {
		if (!window.piDesktop || bootstrappedRef.current) return;
		bootstrappedRef.current = true;
		setStarting(true);
		void window.piDesktop
			.bootstrapConversations({ model: "deepseek-v4-pro", provider: "deepseek" })
			.then((result) => {
				setAgentState(result.agentState);
				setActiveConversationId(result.conversation.id);
				setConversations(result.conversations);
				setMessages(result.conversation.messages);
				setProject(result.conversation.project);
			})
			.catch((startError: unknown) => {
				setError(startError instanceof Error ? startError.message : String(startError));
			})
			.finally(() => setStarting(false));
	}, []);

	async function openProject(): Promise<void> {
		setWorkspaceView("chat");
		setError(undefined);
		const selection = await window.piDesktop.selectProject();
		if (!selection) return;
		setStarting(true);
		try {
			const conversation = await window.piDesktop.createConversation({
				model: "deepseek-v4-pro",
				project: selection,
				provider: "deepseek",
			});
			setProject(selection);
			setActiveConversationId(conversation.id);
			setMessages(conversation.messages);
			refreshConversationList();
		} catch (startError) {
			setError(startError instanceof Error ? startError.message : String(startError));
		} finally {
			setStarting(false);
		}
	}

	async function openConversation(conversationId: string): Promise<void> {
		setWorkspaceView("chat");
		if (conversationId === activeConversationId || streaming || starting) return;
		setError(undefined);
		setStarting(true);
		try {
			const conversation = await window.piDesktop.openConversation(conversationId);
			setActiveConversationId(conversation.id);
			setMessages(conversation.messages);
			setProject(conversation.project);
			setAttachments([]);
		} catch (openError) {
			setError(openError instanceof Error ? openError.message : String(openError));
		} finally {
			setStarting(false);
		}
	}

	async function addAttachments(): Promise<void> {
		setError(undefined);
		try {
			const selected = await window.piDesktop.selectAttachments();
			setAttachments((current) => {
				const existingPaths = new Set(current.map((attachment) => attachment.path));
				return [...current, ...selected.filter((attachment) => !existingPaths.has(attachment.path))].slice(0, 10);
			});
		} catch (selectionError) {
			setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
		}
	}

	async function submit(event: FormEvent): Promise<void> {
		event.preventDefault();
		const message = input.trim();
		if ((!message && attachments.length === 0) || !agentState || streaming || starting) return;
		setError(undefined);
		const attachmentSummary = attachments.map((attachment) => attachment.name).join("、");
		const visibleMessage = [message, attachmentSummary && `附件：${attachmentSummary}`].filter(Boolean).join("\n\n");
		setMessages((current) => [
			...current,
			{ content: visibleMessage, createdAt: Date.now(), id: crypto.randomUUID(), role: "user" },
		]);
		setInput("");
		setAttachments([]);
		const creatingConversation = activeConversationId === undefined;
		if (creatingConversation) setStarting(true);
		try {
			let conversationId = activeConversationId;
			if (!conversationId) {
				const conversation = await window.piDesktop.createConversation({
					model: agentState.model?.id ?? "deepseek-v4-pro",
					provider: agentState.model?.provider ?? "deepseek",
				});
				conversationId = conversation.id;
				activeConversationRef.current = conversation.id;
				setActiveConversationId(conversation.id);
				refreshConversationList();
			}
			await window.piDesktop.sendPrompt(conversationId, message, visibleMessage, attachments);
		} catch (promptError) {
			setError(promptError instanceof Error ? promptError.message : String(promptError));
			setStreaming(false);
		} finally {
			if (creatingConversation) setStarting(false);
		}
	}

	function newSession(): void {
		setWorkspaceView("chat");
		if (!agentState || streaming) return;
		setError(undefined);
		activeConversationRef.current = undefined;
		setActiveConversationId(undefined);
		setProject(undefined);
		setMessages([]);
		setAttachments([]);
		setInput("");
		window.requestAnimationFrame(() => composerInputRef.current?.focus());
	}

	async function renameConversation(conversation: ConversationSummary): Promise<void> {
		setConversationMenu(undefined);
		const title = window.prompt("重命名对话", conversation.title)?.trim();
		if (!title || title === conversation.title) return;
		try {
			setConversations(await window.piDesktop.renameConversation(conversation.id, title));
		} catch (renameError) {
			setError(renameError instanceof Error ? renameError.message : String(renameError));
		}
	}

	async function togglePinned(conversation: ConversationSummary): Promise<void> {
		setConversationMenu(undefined);
		try {
			setConversations(
				await window.piDesktop.setConversationPinned(conversation.id, conversation.pinnedAt === undefined),
			);
		} catch (pinError) {
			setError(pinError instanceof Error ? pinError.message : String(pinError));
		}
	}

	async function archiveConversation(conversation: ConversationSummary): Promise<void> {
		setConversationMenu(undefined);
		try {
			setConversations(await window.piDesktop.archiveConversation(conversation.id));
		} catch (archiveError) {
			setError(archiveError instanceof Error ? archiveError.message : String(archiveError));
		}
	}

	async function deleteConversation(conversation: ConversationSummary): Promise<void> {
		setConversationMenu(undefined);
		if (!window.confirm(`确定删除“${conversation.title}”吗？此操作无法撤销。`)) return;
		try {
			setConversations(await window.piDesktop.deleteConversation(conversation.id));
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	}

	function openConversationMenu(conversation: ConversationSummary, x: number, y: number): void {
		setConversationMenu({
			conversation,
			x: Math.max(8, Math.min(x, window.innerWidth - 174)),
			y: Math.max(8, Math.min(y, window.innerHeight - 190)),
		});
	}

	async function abort(): Promise<void> {
		try {
			await window.piDesktop.abortAgent();
		} catch (abortError) {
			setError(abortError instanceof Error ? abortError.message : String(abortError));
		}
	}

	function cycleTheme(): void {
		setThemeMode((current) => (current === "auto" ? "light" : current === "light" ? "dark" : "auto"));
	}

	function handleSidebarResizePointerDown(event: PointerEvent<HTMLDivElement>): void {
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		sidebarResizeRef.current = { startWidth: sidebarWidth, startX: event.clientX };
	}

	function handleSidebarResizePointerMove(event: PointerEvent<HTMLDivElement>): void {
		const resize = sidebarResizeRef.current;
		if (!resize) return;
		setSidebarWidth(clampSidebarWidth(resize.startWidth + event.clientX - resize.startX));
	}

	function finishSidebarResize(event: PointerEvent<HTMLDivElement>): void {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		sidebarResizeRef.current = null;
	}

	function handleSidebarResizeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
			event.preventDefault();
			if (event.key === "Home") {
				setSidebarWidth(MIN_SIDEBAR_WIDTH);
				return;
			}
			if (event.key === "End") {
				setSidebarWidth(MAX_SIDEBAR_WIDTH);
				return;
			}
			setSidebarWidth((current) => clampSidebarWidth(current + (event.key === "ArrowRight" ? 10 : -10)));
		}
	}

	function conversationItem(conversation: ConversationSummary) {
		const active = conversation.id === activeConversationId;
		return (
			<button
				aria-current={active ? "page" : undefined}
				aria-haspopup="menu"
				className={`session-item${active ? " active" : ""}`}
				disabled={starting || (streaming && !active)}
				key={conversation.id}
				title="单击打开，双击重命名，右键管理"
				type="button"
				onClick={() => void openConversation(conversation.id)}
				onContextMenu={(event) => {
					event.preventDefault();
					openConversationMenu(conversation, event.clientX, event.clientY);
				}}
				onDoubleClick={() => void renameConversation(conversation)}
				onKeyDown={(event) => {
					if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
					event.preventDefault();
					const bounds = event.currentTarget.getBoundingClientRect();
					openConversationMenu(conversation, bounds.right - 8, bounds.top + 8);
				}}
			>
				<span className="session-title">{conversation.title}</span>
				{conversation.status === "running" && (
					<>
						<span className="visually-hidden">正在运行</span>
						<span aria-hidden="true" className="status-dot" />
					</>
				)}
			</button>
		);
	}

	return (
		<div
			className="app-shell"
			style={{
				gridTemplateColumns: sidebarCollapsed ? "0 0 minmax(0, 1fr)" : `${sidebarWidth}px 8px minmax(0, 1fr)`,
			}}
		>
			<fieldset
				className="window-controls"
				aria-label="窗口控制"
				style={{ width: sidebarCollapsed ? COLLAPSED_TOOLBAR_WIDTH : sidebarWidth }}
			>
				<div className="traffic-lights">
					<button
						aria-label="关闭窗口"
						className="traffic-light close"
						type="button"
						onClick={() => void window.piDesktop.closeWindow()}
					/>
					<button
						aria-label="最小化窗口"
						className="traffic-light minimize"
						type="button"
						onClick={() => void window.piDesktop.minimizeWindow()}
					/>
					<button
						aria-label="最大化窗口"
						className="traffic-light maximize"
						type="button"
						onClick={() => void window.piDesktop.toggleMaximizeWindow()}
					/>
				</div>
				<div className="window-navigation">
					<button
						aria-label={sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}
						className="window-icon-button"
						title={sidebarCollapsed ? "显示侧边栏" : "隐藏侧边栏"}
						type="button"
						onClick={() => setSidebarCollapsed((current) => !current)}
					>
						<Icon name="sidebar" />
					</button>
					<button
						aria-label="后退"
						className="window-icon-button"
						type="button"
						onClick={() => window.history.back()}
					>
						<Icon name="back" />
					</button>
					<button
						aria-label="前进"
						className="window-icon-button"
						type="button"
						onClick={() => window.history.forward()}
					>
						<Icon name="forward" />
					</button>
				</div>
			</fieldset>
			<aside className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}>
				<nav className="sidebar-nav" aria-label="主导航">
					<button
						aria-current={workspaceView === "chat" ? "page" : undefined}
						className={`nav-item${workspaceView === "chat" ? " active" : ""}`}
						disabled={!agentState || streaming || starting}
						type="button"
						onClick={newSession}
					>
						<Icon name="add" />
						<span>新聊天</span>
					</button>
					<button className="nav-item" type="button">
						<Icon name="image" />
						<span>图像</span>
					</button>
					<button className="nav-item" type="button">
						<Icon name="schedule" />
						<span>定时任务</span>
					</button>
					<button
						aria-current={workspaceView === "plugins" ? "page" : undefined}
						className={`nav-item${workspaceView === "plugins" ? " active" : ""}`}
						type="button"
						onClick={() => setWorkspaceView("plugins")}
					>
						<Icon name="plugin" />
						<span>插件</span>
					</button>
					<button className="nav-item" type="button">
						<Icon name="explore" />
						<span>探索</span>
					</button>
				</nav>

				<div className="sidebar-section sessions">
					<nav className="session-list" aria-label="对话列表">
						{pinnedConversations.length > 0 && (
							<>
								<div className="section-label">置顶</div>
								{pinnedConversations.map(conversationItem)}
							</>
						)}
						<div className="section-label recent-label">最近</div>
						{recentConversations.map(conversationItem)}
						{!agentState && <p className="empty-note">正在连接 Agent</p>}
					</nav>
				</div>

				<div className="sidebar-section project-section">
					<div className="section-label">项目</div>
					<button className="project-card" type="button" onClick={openProject}>
						<Icon name="folder" />
						<span>{project?.name ?? "打开项目"}</span>
					</button>
				</div>

				<div className="sidebar-footer">
					<div className="connection-label">
						<span className={agentState ? "connection online" : "connection"} />
						<span>{agentState ? (project ? "项目模式" : "自由对话模式") : "正在连接"}</span>
					</div>
					<button
						aria-label={`切换主题，当前为${themeLabel(themeMode)}模式`}
						className="theme-button"
						title={`主题：${themeLabel(themeMode)}`}
						type="button"
						onClick={cycleTheme}
					>
						<ThemeIcon mode={themeMode} />
					</button>
				</div>
			</aside>
			{!sidebarCollapsed && (
				<hr
					aria-label="调整侧边栏宽度"
					aria-orientation="vertical"
					aria-valuemax={MAX_SIDEBAR_WIDTH}
					aria-valuemin={MIN_SIDEBAR_WIDTH}
					aria-valuenow={sidebarWidth}
					className="sidebar-resizer"
					tabIndex={0}
					onKeyDown={handleSidebarResizeKeyDown}
					onPointerCancel={finishSidebarResize}
					onPointerDown={handleSidebarResizePointerDown}
					onPointerMove={handleSidebarResizePointerMove}
					onPointerUp={finishSidebarResize}
				/>
			)}
			<div
				aria-hidden="true"
				className="window-drag-region"
				style={{ left: sidebarCollapsed ? COLLAPSED_TOOLBAR_WIDTH : sidebarWidth + 8 }}
			/>
			{conversationMenu && (
				<div
					aria-label="对话操作"
					className="conversation-menu"
					role="menu"
					style={{ left: conversationMenu.x, top: conversationMenu.y }}
				>
					<button
						role="menuitem"
						type="button"
						onClick={() => void renameConversation(conversationMenu.conversation)}
					>
						重命名
					</button>
					<button role="menuitem" type="button" onClick={() => void togglePinned(conversationMenu.conversation)}>
						{conversationMenu.conversation.pinnedAt === undefined ? "置顶" : "取消置顶"}
					</button>
					<button
						disabled={conversationMenu.conversation.id === activeConversationId}
						role="menuitem"
						type="button"
						onClick={() => void archiveConversation(conversationMenu.conversation)}
					>
						归档
					</button>
					<button
						className="danger"
						disabled={conversationMenu.conversation.id === activeConversationId}
						role="menuitem"
						type="button"
						onClick={() => void deleteConversation(conversationMenu.conversation)}
					>
						删除
					</button>
				</div>
			)}

			{workspaceView === "plugins" ? (
				<McpPanel />
			) : (
				<main className="workspace">
					<div className="content-grid">
						<section aria-live="polite" className="conversation">
							{messages.length === 0 ? (
								<output className="conversation-empty">
									<span aria-hidden="true" className="conversation-empty-mark">
										D
									</span>
									<h1>{!agentState ? "正在连接 Agent…" : starting ? "正在准备对话…" : "有什么可以帮你？"}</h1>
									<p>
										{!agentState || starting
											? "连接完成后即可开始"
											: project
												? `已就绪，可以在 ${project.name} 中开始工作`
												: "Agent 已就绪，输入消息开始新对话"}
									</p>
								</output>
							) : (
								<div className="message-list">
									{messages.map((message) => (
										<article className={`message ${message.role}`} key={message.id}>
											<div className="message-content">{message.content}</div>
											{message.streaming && <span className="streaming-cursor" />}
										</article>
									))}
								</div>
							)}
							<div ref={messageEndRef} />
						</section>
					</div>

					{error && (
						<div className="error-banner" role="alert">
							{error}
						</div>
					)}

					<form className="composer" onSubmit={submit}>
						{attachments.length > 0 && (
							<div className="attachment-list">
								{attachments.map((attachment) => (
									<span className="attachment-chip" key={attachment.path}>
										<span>{attachment.name}</span>
										<button
											aria-label={`移除 ${attachment.name}`}
											type="button"
											onClick={() =>
												setAttachments((current) => current.filter((item) => item.path !== attachment.path))
											}
										>
											<Icon name="close" />
										</button>
									</span>
								))}
							</div>
						)}
						<div className="composer-row">
							<button
								aria-label="添加文件"
								className="attachment-button"
								disabled={!agentState || starting || streaming}
								title="添加文件"
								type="button"
								onClick={addAttachments}
							>
								<Icon name="add" />
							</button>
							<textarea
								ref={composerInputRef}
								disabled={!agentState || starting}
								placeholder="给DDClaw 发消息"
								rows={1}
								value={input}
								onChange={(event) => setInput(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										event.currentTarget.form?.requestSubmit();
									}
								}}
							/>
							<div aria-hidden="true" className="composer-controls">
								<span className="composer-language">
									<span>中</span>
									<Icon name="chevron-down" />
								</span>
								<span className="composer-voice">
									<Icon name="microphone" />
								</span>
							</div>
							{streaming ? (
								<button aria-label="停止任务" className="send-button stop" type="button" onClick={abort}>
									<Icon name="stop" />
								</button>
							) : (
								<button
									aria-label="发送消息"
									className="send-button"
									disabled={!agentState || (!input.trim() && attachments.length === 0)}
									type="submit"
								>
									<Icon name="send" />
								</button>
							)}
						</div>
					</form>
				</main>
			)}
		</div>
	);
}
