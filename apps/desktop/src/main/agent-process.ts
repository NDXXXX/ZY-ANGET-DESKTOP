import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface AgentProcessOptions {
	approved: boolean;
	cliPath: string;
	cwd: string;
	model: string;
	provider: string;
	toolsEnabled: boolean;
}

export type AgentProcessEvent = Record<string, unknown> & { type: string };

export interface AgentImage {
	data: string;
	mimeType: string;
	type: "image";
}

interface PendingRequest {
	reject: (error: Error) => void;
	resolve: (data: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export class AgentProcess {
	private child: ChildProcessWithoutNullStreams | undefined;
	private decoder = new StringDecoder("utf8");
	private eventListener: ((event: AgentProcessEvent) => void) | undefined;
	private lineBuffer = "";
	private pending = new Map<string, PendingRequest>();
	private requestId = 0;
	private stderr = "";

	onEvent(listener: (event: AgentProcessEvent) => void): void {
		this.eventListener = listener;
	}

	async start(options: AgentProcessOptions): Promise<unknown> {
		await this.stop();
		this.stderr = "";
		this.lineBuffer = "";
		this.decoder = new StringDecoder("utf8");

		const args = [
			options.cliPath,
			"--mode",
			"rpc",
			"--no-session",
			"--provider",
			options.provider,
			"--model",
			options.model,
			options.approved ? "--approve" : "--no-approve",
		];
		if (!options.toolsEnabled) args.push("--no-tools");

		const child = spawn(process.execPath, args, {
			cwd: options.cwd,
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stdout.on("data", (chunk: Buffer) => this.consumeOutput(this.decoder.write(chunk)));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-20_000);
		});
		child.once("error", (error) => this.handleExit(new Error(`Agent process failed: ${error.message}`)));
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.consumeOutput(this.decoder.end());
			this.handleExit(
				new Error(`Agent process exited (code=${code ?? "none"}, signal=${signal ?? "none"}). ${this.stderr}`),
			);
		});

		return this.send({ type: "get_state" });
	}

	async prompt(message: string, images: AgentImage[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	async loadSession(cwd: string, sessionId: string, entries: Array<Record<string, unknown>>): Promise<unknown> {
		await this.send({ type: "load_session", cwd, sessionId, entries });
		return this.send({ type: "get_state" });
	}

	async getEntries(): Promise<Array<Record<string, unknown>>> {
		const result = await this.send({ type: "get_entries" });
		if (!isRecord(result) || !Array.isArray(result.entries)) throw new Error("Agent returned invalid entries");
		return result.entries.filter(isRecord);
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		child.kill("SIGTERM");
		this.rejectPending(new Error("Agent process stopped"));
	}

	private consumeOutput(chunk: string): void {
		this.lineBuffer += chunk;
		let newline = this.lineBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.lineBuffer.slice(0, newline).replace(/\r$/, "");
			this.lineBuffer = this.lineBuffer.slice(newline + 1);
			if (line) this.handleLine(line);
			newline = this.lineBuffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") return;

		if (parsed.type === "response" && typeof parsed.id === "string") {
			const request = this.pending.get(parsed.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(parsed.id);
			if (parsed.success === true) {
				request.resolve(parsed.data);
			} else {
				request.reject(new Error(typeof parsed.error === "string" ? parsed.error : "Agent request failed"));
			}
			return;
		}

		this.eventListener?.(parsed as AgentProcessEvent);
	}

	private send(command: Record<string, unknown>): Promise<unknown> {
		const child = this.child;
		if (!child || !child.stdin.writable) throw new Error("Agent is not running");
		const id = `desktop_${++this.requestId}`;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent did not respond to ${String(command.type)}`));
			}, 30_000);
			this.pending.set(id, { reject, resolve, timer });
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	private handleExit(error: Error): void {
		this.child = undefined;
		this.rejectPending(error);
		this.eventListener?.({ type: "desktop_process_exit", message: error.message });
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}
