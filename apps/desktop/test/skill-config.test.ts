import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverInstalledSkills } from "../src/main/skill-config.ts";

describe("skill-config", () => {
	let directory: string;

	beforeEach(() => {
		directory = join(tmpdir(), `ddclaw-skills-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
	});

	afterEach(() => {
		rmSync(directory, { force: true, recursive: true });
	});

	it("discovers nested Agent Skills with their scope", () => {
		const personalRoot = join(directory, "personal");
		const skillDirectory = join(personalRoot, "writing-helper");
		mkdirSync(skillDirectory, { recursive: true });
		writeFileSync(
			join(skillDirectory, "SKILL.md"),
			"---\nname: writing-helper\ndescription: Improve technical writing.\n---\nInstructions",
		);

		expect(discoverInstalledSkills([{ path: personalRoot, scope: "personal" }])).toEqual([
			{
				description: "Improve technical writing.",
				name: "writing-helper",
				path: join(skillDirectory, "SKILL.md"),
				scope: "personal",
			},
		]);
	});

	it("reads multiline descriptions and direct markdown skills", () => {
		const projectRoot = join(directory, "project");
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(
			join(projectRoot, "review.md"),
			"---\nname: review\ndescription: >-\n  Review changes and\n  report concrete issues.\n---\nInstructions",
		);

		expect(discoverInstalledSkills([{ path: projectRoot, scope: "project" }])).toEqual([
			{
				description: "Review changes and report concrete issues.",
				name: "review",
				path: join(projectRoot, "review.md"),
				scope: "project",
			},
		]);
	});

	it("skips markdown files without a skill description", () => {
		writeFileSync(join(directory, "README.md"), "# Notes");

		expect(discoverInstalledSkills([{ path: directory, scope: "personal" }])).toEqual([]);
	});
});
