import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface RuntimeAssetEnvironment {
	agentCliOverride?: string;
	appPath: string;
	cwd: string;
	isPackaged: boolean;
	mcpExtensionOverride?: string;
	resourcesPath: string;
}

export interface RuntimeAssets {
	agentCliPath: string;
	mcpExtensionPath: string;
}

function findRequired(candidates: string[], label: string): string {
	const filePath = candidates.find((candidate) => existsSync(candidate));
	if (!filePath) throw new Error(`找不到 ${label}：${candidates.join("、")}`);
	return filePath;
}

export function resolveRuntimeAssets(environment: RuntimeAssetEnvironment): RuntimeAssets {
	if (environment.isPackaged) {
		return {
			agentCliPath: findRequired(
				[join(environment.resourcesPath, "runtime/agent/dist/bundle/cli.js")],
				"Pi Agent 运行文件",
			),
			mcpExtensionPath: findRequired(
				[join(environment.resourcesPath, "runtime/extensions/mcp/index.ts")],
				"MCP 扩展运行文件",
			),
		};
	}

	const agentCandidates = [
		environment.agentCliOverride,
		resolve(environment.appPath, "../../packages/coding-agent/dist/bundle/cli.js"),
		resolve(environment.cwd, "packages/coding-agent/dist/bundle/cli.js"),
		resolve(environment.cwd, "../../packages/coding-agent/dist/bundle/cli.js"),
	].filter((candidate): candidate is string => Boolean(candidate));
	const extensionCandidates = [
		environment.mcpExtensionOverride,
		resolve(environment.appPath, "../../packages/coding-agent/examples/extensions/mcp/index.ts"),
		resolve(environment.cwd, "packages/coding-agent/examples/extensions/mcp/index.ts"),
		resolve(environment.cwd, "../../packages/coding-agent/examples/extensions/mcp/index.ts"),
	].filter((candidate): candidate is string => Boolean(candidate));

	return {
		agentCliPath: findRequired(agentCandidates, "Pi Agent 构建产物，请先在仓库根目录运行 npm run build"),
		mcpExtensionPath: findRequired(extensionCandidates, "MCP 扩展"),
	};
}
