import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeAssets } from "../src/main/runtime-assets.ts";

describe("resolveRuntimeAssets", () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("uses only packaged resources in a packaged app", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-runtime-assets-"));
		const agentCliPath = join(directory, "resources/runtime/agent/dist/bundle/cli.js");
		const mcpExtensionPath = join(directory, "resources/runtime/extensions/mcp/index.ts");
		mkdirSync(dirname(agentCliPath), { recursive: true });
		mkdirSync(dirname(mcpExtensionPath), { recursive: true });
		writeFileSync(agentCliPath, "");
		writeFileSync(mcpExtensionPath, "");

		expect(
			resolveRuntimeAssets({
				agentCliOverride: "/invalid/override.js",
				appPath: "/invalid/app",
				cwd: "/invalid/cwd",
				isPackaged: true,
				mcpExtensionOverride: "/invalid/extension.ts",
				resourcesPath: join(directory, "resources"),
			}),
		).toEqual({ agentCliPath, mcpExtensionPath });
	});

	it("fails clearly when a packaged runtime file is missing", () => {
		directory = mkdtempSync(join(tmpdir(), "pi-runtime-assets-missing-"));

		expect(() =>
			resolveRuntimeAssets({
				appPath: directory,
				cwd: directory,
				isPackaged: true,
				resourcesPath: directory,
			}),
		).toThrow("找不到 Pi Agent 运行文件");
	});
});
