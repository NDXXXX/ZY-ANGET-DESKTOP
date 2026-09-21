import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(appRoot, "release");
const appContents = join(releaseDir, "win-unpacked");
const executable = join(appContents, "DDClaw.exe");
const requiredFiles = [
	join(appContents, "resources/runtime/agent/package.json"),
	join(appContents, "resources/runtime/agent/dist/bundle/cli.js"),
	join(appContents, "resources/runtime/agent/dist/modes/interactive/theme/dark.json"),
	join(appContents, "resources/runtime/agent/node_modules/jiti/package.json"),
	join(appContents, "resources/runtime/extensions/mcp/index.ts"),
	join(appContents, "resources/runtime/extensions/mcp/node_modules/cross-spawn/package.json"),
];

for (const filePath of [executable, ...requiredFiles]) {
	if (!existsSync(filePath)) throw new Error(`Packaged runtime file is missing: ${filePath}`);
}

const executableBytes = readFileSync(executable);
if (executableBytes.subarray(0, 2).toString("ascii") !== "MZ") {
	throw new Error("Packaged Windows executable does not have an MZ header");
}
const peOffset = executableBytes.readUInt32LE(0x3c);
if (executableBytes.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\0\0") {
	throw new Error("Packaged Windows executable does not have a PE header");
}
if (executableBytes.readUInt16LE(peOffset + 4) !== 0x8664) {
	throw new Error("Packaged Windows executable is not x64");
}

const artifacts = readdirSync(releaseDir);
if (!artifacts.some((name) => name.endsWith(".exe") && name.includes("Setup"))) {
	throw new Error("Windows NSIS installer was not found");
}
if (!artifacts.some((name) => name.endsWith("-win.zip"))) {
	throw new Error("Windows ZIP artifact was not found");
}

console.log("Packaged Windows x64 app and runtime resources are structurally complete.");
