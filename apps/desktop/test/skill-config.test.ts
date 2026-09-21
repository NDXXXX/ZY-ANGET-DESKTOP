import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePersonalSkillsDirectory } from "../src/main/skill-config.ts";

describe("skill-config", () => {
	let directory: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(() => {
		directory = join(tmpdir(), `ddclaw-skills-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = directory;
	});

	afterEach(() => {
		rmSync(directory, { force: true, recursive: true });
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});

	it("creates and returns the personal skills directory", () => {
		const result = ensurePersonalSkillsDirectory();

		expect(result).toBe(join(directory, "skills"));
		expect(existsSync(result)).toBe(true);
	});
});
