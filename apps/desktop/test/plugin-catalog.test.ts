import { describe, expect, it } from "vitest";
import { pluginCatalog } from "../src/shared/plugin-catalog.ts";

describe("plugin catalog", () => {
	it("pins every built-in package to its declared version", () => {
		for (const plugin of pluginCatalog) {
			expect(plugin.args).toContain(`${plugin.packageName}@${plugin.packageVersion}`);
			expect(plugin.args.some((argument) => argument.includes("@latest"))).toBe(false);
		}
	});

	it("declares local process access for every built-in package", () => {
		for (const plugin of pluginCatalog) {
			expect(plugin.permissions).toContainEqual({ type: "local-process" });
		}
	});
});
