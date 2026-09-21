import { writeFileSync } from "node:fs";

if (process.env.PI_AGENT_TEST_PID_FILE) {
	writeFileSync(process.env.PI_AGENT_TEST_PID_FILE, String(process.pid));
}

function respond(message) {
	if (message.id === undefined) return;
	const data =
		message.type === "get_state"
			? {
					isStreaming: false,
					model: { id: "test", provider: "test" },
					sessionId: "test-session",
					thinkingLevel: "off",
				}
			: message.type === "get_skills"
				? { diagnostics: [], skills: [] }
			: {};
	process.stdout.write(`${JSON.stringify({ command: message.type, data, id: message.id, success: true, type: "response" })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line) respond(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});

if (process.env.PI_AGENT_TEST_IGNORE_SHUTDOWN === "1") {
	process.on("SIGTERM", () => {});
} else {
	process.stdin.on("end", () => process.exit(0));
	process.stdin.on("close", () => process.exit(0));
}
