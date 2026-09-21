import type { McpServerConfig } from "./ipc.ts";

export type PluginRisk = "low" | "medium" | "high";

export type PluginPermission =
	| { type: "filesystem"; mode: "read" | "read-write" }
	| { type: "network"; hosts?: string[] }
	| { type: "local-process" };

export interface PluginCatalogEntry {
	args: string[];
	category: string;
	command: string;
	displayName: string;
	glyph: string;
	id: string;
	input?: { label: string };
	packageName: string;
	packageVersion: string;
	permissions: PluginPermission[];
	risk: PluginRisk;
	summary: string;
	tone: string;
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
		packageName: "@playwright/mcp",
		packageVersion: "0.0.82",
		args: ["-y", "@playwright/mcp@0.0.82"],
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
		packageName: "chrome-devtools-mcp",
		packageVersion: "1.9.0",
		args: ["-y", "chrome-devtools-mcp@1.9.0"],
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
		packageName: "@upstash/context7-mcp",
		packageVersion: "4.1.1",
		args: ["-y", "@upstash/context7-mcp@4.1.1"],
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
		packageName: "@modelcontextprotocol/server-filesystem",
		packageVersion: "2026.8.31",
		args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"],
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
		packageName: "@modelcontextprotocol/server-memory",
		packageVersion: "2026.8.31",
		args: ["-y", "@modelcontextprotocol/server-memory@2026.8.31"],
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
		packageName: "@modelcontextprotocol/server-sequential-thinking",
		packageVersion: "2026.8.31",
		args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.8.31"],
	},
];

export const catalogById = new Map(pluginCatalog.map((entry) => [entry.id, entry]));

export function permissionsForConfig(config: McpServerConfig): PluginPermission[] {
	if (config.type === "stdio") return [{ type: "local-process" }];
	try {
		return [{ type: "network", hosts: [new URL(config.url).hostname] }];
	} catch {
		return [{ type: "network" }];
	}
}

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
