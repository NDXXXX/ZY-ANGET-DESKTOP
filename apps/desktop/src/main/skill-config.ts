import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function resolveAgentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

export function ensurePersonalSkillsDirectory(): string {
	const skillsDirectory = join(resolveAgentDirectory(), "skills");
	mkdirSync(skillsDirectory, { recursive: true });
	return skillsDirectory;
}
