/**
 * Built-in plugin catalog.
 *
 * The catalog only describes plugins to the UI (name, capability, permissions,
 * risk). The actual MCP server definition is written to `mcp-servers.json` by
 * the main process — the catalog itself is never persisted.
 *
 * Risk levels follow the design doc's table: low = read-only remote docs,
 * medium = browser control or network debugging, high = access to local files,
 * local commands, or anything not reviewed (custom MCP servers).
 */

import type { McpServerConfig } from "../../shared/ipc.ts";

export type PluginRisk = "low" | "medium" | "high";

export type PluginPermission =
	| { type: "filesystem"; mode: "read" | "read-write" }
	| { type: "network"; hosts?: string[] }
	| { type: "local-process" };

export interface PluginCatalogEntry {
	id: string;
	displayName: string;
	summary: string;
	category: string;
	glyph: string;
	tone: string;
	risk: PluginRisk;
	permissions: PluginPermission[];
	command: string;
	args: string[];
	/** Plugins that need one more value (a directory, say) before they can run. */
	input?: { label: string };
}

export const riskLabels: Record<PluginRisk, string> = {
	high: "高风险",
	low: "低风险",
	medium: "中风险",
};

export const pluginCatalog: PluginCatalogEntry[] = [
	{
		id: "playwright",
		displayName: "Playwright",
		summary: "浏览器自动化、截图、点击与表单操作",
		category: "开发工具",
		glyph: "P",
		tone: "blue",
		risk: "medium",
		permissions: [{ type: "local-process" }, { type: "network" }],
		command: "npx",
		args: ["-y", "@playwright/mcp@latest"],
	},
	{
		id: "chrome-devtools",
		displayName: "Chrome DevTools",
		summary: "调试 Chrome 的性能、网络与控制台",
		category: "开发工具",
		glyph: "C",
		tone: "cyan",
		risk: "medium",
		permissions: [{ type: "local-process" }, { type: "network" }],
		command: "npx",
		args: ["-y", "chrome-devtools-mcp@latest"],
	},
	{
		id: "context7",
		displayName: "Context7",
		summary: "查找第三方库的最新官方文档",
		category: "知识与文档",
		glyph: "7",
		tone: "violet",
		risk: "low",
		permissions: [{ type: "local-process" }, { type: "network", hosts: ["context7.com"] }],
		command: "npx",
		args: ["-y", "@upstash/context7-mcp"],
	},
	{
		id: "filesystem",
		displayName: "文件系统",
		summary: "允许 Agent 访问你指定的目录",
		category: "文件与数据",
		glyph: "F",
		tone: "amber",
		risk: "high",
		permissions: [{ type: "local-process" }, { type: "filesystem", mode: "read-write" }],
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-filesystem"],
		input: { label: "选择要授权的目录" },
	},
	{
		id: "memory",
		displayName: "Memory",
		summary: "跨会话保存知识图谱记忆",
		category: "效率",
		glyph: "M",
		tone: "green",
		risk: "low",
		permissions: [{ type: "local-process" }],
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-memory"],
	},
	{
		id: "sequential-thinking",
		displayName: "Sequential Thinking",
		summary: "为复杂任务提供结构化分步推理",
		category: "效率",
		glyph: "S",
		tone: "rose",
		risk: "low",
		permissions: [{ type: "local-process" }],
		command: "npx",
		args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
	},
];

export const catalogById = new Map(pluginCatalog.map((entry) => [entry.id, entry]));

/** Permissions implied by a server definition the user brought themselves. */
export function permissionsForConfig(config: McpServerConfig): PluginPermission[] {
	if (config.type === "stdio") return [{ type: "local-process" }];
	try {
		const hosts = [new URL(config.url).hostname];
		return [{ type: "network", hosts }];
	} catch {
		return [{ type: "network" }];
	}
}

/** One-line form shown on the plugin card, before anything is installed. */
export function permissionChip(permission: PluginPermission): string {
	if (permission.type === "local-process") return "本地进程";
	if (permission.type === "network")
		return permission.hosts?.length ? `网络 · ${permission.hosts.join("、")}` : "网络";
	return permission.mode === "read-write" ? "读写文件" : "读取文件";
}

export function permissionLabel(permission: PluginPermission, configuration?: Record<string, string>): string {
	if (permission.type === "local-process") return "在你的电脑上启动并运行该插件的程序";
	if (permission.type === "network") {
		return permission.hosts?.length ? `访问网络：${permission.hosts.join("、")}` : "访问网络";
	}
	const scope = configuration?.directory ? `：${configuration.directory}` : "（安装时选择目录）";
	return `${permission.mode === "read-write" ? "读写" : "读取"}本地文件${scope}`;
}
