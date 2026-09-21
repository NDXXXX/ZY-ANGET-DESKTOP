import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../../../../packages/coding-agent/src/utils/frontmatter.ts";
import type { InstalledSkill, InstalledSkillScope } from "../shared/ipc.ts";

interface SkillRoot {
	path: string;
	scope: InstalledSkillScope;
}

interface SkillFrontmatter {
	description?: unknown;
	name?: unknown;
	[key: string]: unknown;
}

function resolveAgentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

function readSkill(filePath: string, scope: InstalledSkillScope): InstalledSkill | undefined {
	try {
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readFileSync(filePath, "utf8"));
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return undefined;
		const name =
			typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: basename(dirname(filePath));
		return {
			description: frontmatter.description.trim(),
			name,
			path: filePath,
			scope,
		};
	} catch {
		return undefined;
	}
}

function collectSkills(
	directory: string,
	scope: InstalledSkillScope,
	includeRootFiles: boolean,
	visitedDirectories: Set<string>,
): InstalledSkill[] {
	if (!existsSync(directory)) return [];

	try {
		const canonicalDirectory = realpathSync(directory);
		if (visitedDirectories.has(canonicalDirectory)) return [];
		visitedDirectories.add(canonicalDirectory);

		const entries = readdirSync(directory, { withFileTypes: true });
		const declaredSkill = entries.find((entry) => entry.name === "SKILL.md");
		if (declaredSkill) {
			const filePath = join(directory, declaredSkill.name);
			if (statSync(filePath).isFile()) {
				const skill = readSkill(filePath, scope);
				return skill ? [skill] : [];
			}
		}

		const skills: InstalledSkill[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const entryPath = join(directory, entry.name);
			const stats = entry.isSymbolicLink() ? statSync(entryPath) : undefined;
			if (entry.isDirectory() || stats?.isDirectory()) {
				skills.push(...collectSkills(entryPath, scope, false, visitedDirectories));
				continue;
			}
			if (includeRootFiles && (entry.isFile() || stats?.isFile()) && entry.name.endsWith(".md")) {
				const skill = readSkill(entryPath, scope);
				if (skill) skills.push(skill);
			}
		}
		return skills;
	} catch {
		return [];
	}
}

export function discoverInstalledSkills(roots: SkillRoot[]): InstalledSkill[] {
	const skills: InstalledSkill[] = [];
	const seenFiles = new Set<string>();
	const visitedDirectories = new Set<string>();

	for (const root of roots) {
		for (const skill of collectSkills(root.path, root.scope, true, visitedDirectories)) {
			let canonicalPath: string;
			try {
				canonicalPath = realpathSync(skill.path);
			} catch {
				continue;
			}
			if (seenFiles.has(canonicalPath)) continue;
			seenFiles.add(canonicalPath);
			skills.push(skill);
		}
	}

	return skills.sort((left, right) => {
		if (left.scope !== right.scope) return left.scope === "personal" ? -1 : 1;
		return left.name.localeCompare(right.name);
	});
}

export function listInstalledSkills(projectPath?: string): InstalledSkill[] {
	const roots: SkillRoot[] = [
		{ path: join(resolveAgentDirectory(), "skills"), scope: "personal" },
		{ path: join(homedir(), ".agents", "skills"), scope: "personal" },
	];

	if (projectPath) {
		roots.push({ path: join(projectPath, ".pi", "skills"), scope: "project" });
		for (let directory = resolve(projectPath); ; directory = dirname(directory)) {
			roots.push({ path: join(directory, ".agents", "skills"), scope: "project" });
			if (dirname(directory) === directory) break;
		}
	}

	return discoverInstalledSkills(roots);
}

export function ensurePersonalSkillsDirectory(): string {
	const skillsDirectory = join(resolveAgentDirectory(), "skills");
	mkdirSync(skillsDirectory, { recursive: true });
	return skillsDirectory;
}
