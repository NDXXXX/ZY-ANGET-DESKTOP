import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const appRoot = new URL("..", import.meta.url).pathname;
const releaseDir = join(appRoot, "release");
const macDirectory = readdirSync(releaseDir).find((name) => name.startsWith("mac"));
if (!macDirectory) throw new Error("Packaged macOS directory was not found");

const appContents = join(releaseDir, macDirectory, "DDClaw.app", "Contents");
const executable = join(appContents, "MacOS", "DDClaw");
const requiredFiles = [
	join(appContents, "Resources/runtime/agent/package.json"),
	join(appContents, "Resources/runtime/agent/dist/bundle/cli.js"),
	join(appContents, "Resources/runtime/agent/dist/modes/interactive/theme/dark.json"),
	join(appContents, "Resources/runtime/agent/node_modules/jiti/package.json"),
	join(appContents, "Resources/runtime/extensions/mcp/index.ts"),
	join(appContents, "Resources/runtime/extensions/mcp/node_modules/cross-spawn/package.json"),
];
for (const filePath of [executable, ...requiredFiles]) {
	if (!existsSync(filePath)) throw new Error(`Packaged runtime file is missing: ${filePath}`);
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findAgentPid(parentPid) {
	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="]);
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!match || Number(match[2]) !== parentPid) continue;
		if (match[3].trim() === "pi") return Number(match[1]);
	}
	return undefined;
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const temporaryHome = mkdtempSync(join(tmpdir(), "ddclaw-packaged-smoke-"));
const environment = { ...process.env, HOME: temporaryHome };
delete environment.ELECTRON_RUN_AS_NODE;

const app = spawn(executable, [`--user-data-dir=${join(temporaryHome, "user-data")}`], {
	env: environment,
	stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
app.stderr.on("data", (chunk) => {
	stderr = `${stderr}${chunk.toString("utf8")}`.slice(-20_000);
});

let agentPid;
try {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && app.exitCode === null) {
		agentPid = await findAgentPid(app.pid);
		if (agentPid !== undefined) break;
		await delay(100);
	}
	if (agentPid === undefined) throw new Error(`Packaged Agent did not become ready. ${stderr}`);
	await delay(500);
	if (!isAlive(agentPid)) throw new Error(`Packaged Agent exited during startup. ${stderr}`);

	app.kill("SIGTERM");
	const exitDeadline = Date.now() + 10_000;
	while (Date.now() < exitDeadline && app.exitCode === null) await delay(50);
	if (app.exitCode === null) throw new Error("Packaged desktop process did not exit after SIGTERM");
	if (isAlive(agentPid)) throw new Error("Packaged Agent process remained after the desktop app exited");
	console.log("Packaged macOS app started its Agent and exited without leaving a child process.");
} finally {
	if (app.exitCode === null) app.kill("SIGKILL");
	rmSync(temporaryHome, { recursive: true, force: true });
}
