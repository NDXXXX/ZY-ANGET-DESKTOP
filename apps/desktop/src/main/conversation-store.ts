import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ConversationDetail,
	ConversationMessage,
	ConversationStatus,
	ConversationSummary,
	CreateConversationOptions,
	SelectedProject,
} from "../shared/ipc.ts";

export type SessionEntryRecord = Record<string, unknown> & {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
};

interface ConversationRow {
	archived_at: number | null;
	created_at: number;
	id: string;
	last_message_preview: string | null;
	model: string;
	pinned_at: number | null;
	project_name: string | null;
	project_path: string | null;
	provider: string;
	status: ConversationStatus;
	title: string;
	updated_at: number;
}

interface ConversationRecord extends ConversationRow {
	current_transcript_id: string;
}

interface EntryRow {
	created_at: number;
	id: string;
	payload_json: string;
	role: string | null;
	searchable_text: string | null;
}

interface SettingRow {
	value_json: string;
}

interface LegacyHeader {
	cwd: string;
	id: string;
	timestamp?: string;
	type: "session";
}

interface LegacyImportDefaults {
	freeChatCwd: string;
	model: string;
	provider: string;
	sessionsDir?: string;
}

const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  current_transcript_id TEXT,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL CHECK (title_source IN ('default', 'auto', 'user')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'error')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_message_at INTEGER,
  pinned_at INTEGER,
  archived_at INTEGER,
  last_read_at INTEGER
);

CREATE INDEX IF NOT EXISTS conversations_list_idx
  ON conversations(archived_at, pinned_at DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_project_idx
  ON conversations(project_id, archived_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  active_leaf_entry_id TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  reset_reason TEXT
);

CREATE INDEX IF NOT EXISTS transcripts_conversation_idx
  ON transcripts(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  parent_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  role TEXT,
  payload_json TEXT NOT NULL,
  searchable_text TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'interrupted', 'error')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(transcript_id, sequence)
);

CREATE INDEX IF NOT EXISTS entries_transcript_idx ON entries(transcript_id, sequence);
CREATE INDEX IF NOT EXISTS entries_parent_idx ON entries(parent_entry_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  user_entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'aborted', 'failed', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  source_path TEXT,
  content_hash TEXT,
  stored_path TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_imports (
  source_path TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  transcript_id TEXT REFERENCES transcripts(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('imported', 'skipped', 'failed')),
  error_message TEXT,
  imported_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entry_search USING fts5(
  entry_id UNINDEXED,
  conversation_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalNumber(value: number | null): number | undefined {
	return value ?? undefined;
}

function messageText(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part))
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => String(part.text))
		.join("");
}

function entryRole(entry: Record<string, unknown>): string | undefined {
	return entry.type === "message" && isRecord(entry.message) && typeof entry.message.role === "string"
		? entry.message.role
		: undefined;
}

function parseTimestamp(value: string | undefined): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeTitle(text: string): string {
	const title = text.replaceAll(/\s+/g, " ").trim();
	return title.length > 30 ? `${title.slice(0, 30)}…` : title || "新聊天";
}

function toSummary(row: ConversationRow): ConversationSummary {
	const project =
		row.project_name && row.project_path ? { name: row.project_name, path: row.project_path } : undefined;
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		provider: row.provider,
		model: row.model,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		pinnedAt: optionalNumber(row.pinned_at),
		archivedAt: optionalNumber(row.archived_at),
		lastMessagePreview: row.last_message_preview ?? undefined,
		project,
	};
}

function collectJsonlFiles(root: string): string[] {
	const files: string[] = [];
	for (const item of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, item.name);
		if (item.isDirectory()) files.push(...collectJsonlFiles(path));
		if (item.isFile() && item.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

export function defaultConversationDatabasePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
	return join(agentDir, "ddclaw.sqlite");
}

export class ConversationStore {
	private readonly db: DatabaseSync;

	constructor(databasePath: string = defaultConversationDatabasePath()) {
		mkdirSync(dirname(databasePath), { recursive: true });
		this.db = new DatabaseSync(databasePath);
		this.db.exec(
			"PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
		);
		this.db.exec(schema);
		this.db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, Date.now());
	}

	close(): void {
		this.db.close();
	}

	createConversation(options: CreateConversationOptions, conversationKey?: string): ConversationDetail {
		const now = Date.now();
		const conversationId = randomUUID();
		const transcriptId = randomUUID();
		const projectId = options.project ? this.upsertProject(options.project, now) : null;

		this.transaction(() => {
			this.db
				.prepare(`INSERT INTO conversations (
					id, conversation_key, project_id, current_transcript_id, title, title_source,
					provider, model, status, created_at, updated_at, last_read_at
				) VALUES (?, ?, ?, NULL, '新聊天', 'default', ?, ?, 'idle', ?, ?, ?)`)
				.run(
					conversationId,
					conversationKey ?? `desktop:${conversationId}`,
					projectId,
					options.provider,
					options.model,
					now,
					now,
					now,
				);
			this.db
				.prepare("INSERT INTO transcripts (id, conversation_id, created_at) VALUES (?, ?, ?)")
				.run(transcriptId, conversationId, now);
			this.db
				.prepare("UPDATE conversations SET current_transcript_id = ? WHERE id = ?")
				.run(transcriptId, conversationId);
			this.setSetting("lastConversationId", conversationId);
		});

		return this.getConversation(conversationId);
	}

	listConversations(): ConversationSummary[] {
		const rows = this.db
			.prepare(`SELECT c.id, c.title, c.provider, c.model, c.status, c.created_at, c.updated_at,
				c.pinned_at, c.archived_at, p.name AS project_name, p.path AS project_path,
				(SELECT e.searchable_text FROM entries e
				 WHERE e.transcript_id = c.current_transcript_id AND e.searchable_text IS NOT NULL
				 ORDER BY e.sequence DESC LIMIT 1) AS last_message_preview
			FROM conversations c
			LEFT JOIN projects p ON p.id = c.project_id
			WHERE c.archived_at IS NULL
			ORDER BY c.pinned_at IS NULL, c.pinned_at DESC, c.updated_at DESC`)
			.all() as unknown as ConversationRow[];
		return rows.map(toSummary);
	}

	getConversation(conversationId: string): ConversationDetail {
		const row = this.readConversationRow(conversationId);
		const entries = this.db
			.prepare(`SELECT id, role, payload_json, searchable_text, created_at
				FROM entries WHERE transcript_id = ? AND entry_type = 'message'
				ORDER BY sequence ASC`)
			.all(row.current_transcript_id) as unknown as EntryRow[];
		const messages: ConversationMessage[] = [];
		for (const entry of entries) {
			if (entry.role !== "user" && entry.role !== "assistant" && entry.role !== "system") continue;
			const payload = JSON.parse(entry.payload_json) as unknown;
			const content = entry.searchable_text ?? (isRecord(payload) ? messageText(payload) : undefined);
			if (!content) continue;
			messages.push({ id: entry.id, role: entry.role, content, createdAt: entry.created_at });
		}
		return { ...toSummary(row), transcriptId: row.current_transcript_id, messages };
	}

	getSessionEntries(conversationId: string): SessionEntryRecord[] {
		const row = this.readConversationRow(conversationId);
		const entries = this.db
			.prepare("SELECT payload_json FROM entries WHERE transcript_id = ? ORDER BY sequence ASC")
			.all(row.current_transcript_id) as unknown as Array<{ payload_json: string }>;
		return entries.map((entry) => JSON.parse(entry.payload_json) as SessionEntryRecord);
	}

	startRun(conversationId: string): string {
		const conversation = this.readConversationRow(conversationId);
		const runId = randomUUID();
		const now = Date.now();
		this.transaction(() => {
			this.db
				.prepare(`INSERT INTO runs (id, conversation_id, transcript_id, status, started_at)
					VALUES (?, ?, ?, 'running', ?)`)
				.run(runId, conversationId, conversation.current_transcript_id, now);
			this.db
				.prepare("UPDATE conversations SET status = 'running', updated_at = ? WHERE id = ?")
				.run(now, conversationId);
		});
		return runId;
	}

	finishRun(runId: string, status: "aborted" | "completed" | "failed", errorMessage?: string): void {
		const conversationStatus: ConversationStatus = status === "failed" ? "error" : "idle";
		const now = Date.now();
		this.transaction(() => {
			this.db
				.prepare("UPDATE runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?")
				.run(status, now, errorMessage ?? null, runId);
			this.db
				.prepare(`UPDATE conversations SET status = ?, updated_at = ?
					WHERE id = (SELECT conversation_id FROM runs WHERE id = ?)`)
				.run(conversationStatus, now, runId);
		});
	}

	interruptRun(runId: string, errorMessage?: string): void {
		const now = Date.now();
		this.transaction(() => {
			this.db
				.prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, error_message = ? WHERE id = ?")
				.run(now, errorMessage ?? null, runId);
			this.db
				.prepare(`UPDATE conversations SET status = 'interrupted', updated_at = ?
					WHERE id = (SELECT conversation_id FROM runs WHERE id = ?)`)
				.run(now, runId);
		});
	}

	syncEntries(conversationId: string, entries: SessionEntryRecord[], userDisplayText?: string): void {
		const conversation = this.readConversationRow(conversationId);
		const transcriptId = conversation.current_transcript_id;
		const now = Date.now();
		let latestUserIndex = -1;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entryRole(entries[index]) === "user") {
				latestUserIndex = index;
				break;
			}
		}
		const upsert = this.db.prepare(`INSERT INTO entries (
			id, transcript_id, parent_entry_id, sequence, entry_type, role, payload_json,
			searchable_text, status, created_at, completed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			parent_entry_id = excluded.parent_entry_id,
			sequence = excluded.sequence,
			payload_json = excluded.payload_json,
			role = excluded.role,
			searchable_text = COALESCE(entries.searchable_text, excluded.searchable_text),
			status = 'complete',
			completed_at = excluded.completed_at`);

		this.transaction(() => {
			for (const [sequence, entry] of entries.entries()) {
				const databaseEntryId = `${transcriptId}:${entry.id}`;
				const parentEntryId = entry.parentId ? `${transcriptId}:${entry.parentId}` : null;
				const role = entryRole(entry);
				const searchableText =
					sequence === latestUserIndex && userDisplayText !== undefined ? userDisplayText : messageText(entry);
				const createdAt = parseTimestamp(entry.timestamp);
				upsert.run(
					databaseEntryId,
					transcriptId,
					parentEntryId,
					sequence,
					entry.type,
					role ?? null,
					JSON.stringify(entry),
					searchableText ?? null,
					createdAt,
					now,
				);
				if (searchableText && (role === "user" || role === "assistant")) {
					this.db.prepare("DELETE FROM entry_search WHERE entry_id = ?").run(databaseEntryId);
					this.db
						.prepare("INSERT INTO entry_search (entry_id, conversation_id, content) VALUES (?, ?, ?)")
						.run(databaseEntryId, conversationId, searchableText);
				}
			}

			const activeLeafId = entries.at(-1)?.id;
			this.db
				.prepare("UPDATE transcripts SET active_leaf_entry_id = ? WHERE id = ?")
				.run(activeLeafId ? `${transcriptId}:${activeLeafId}` : null, transcriptId);
			const latestText = entries
				.map((entry, index) =>
					index === latestUserIndex && userDisplayText !== undefined ? userDisplayText : messageText(entry),
				)
				.filter((value): value is string => Boolean(value))
				.at(-1);
			this.db
				.prepare(`UPDATE conversations SET
					title = CASE WHEN title_source = 'default' AND ? IS NOT NULL THEN ? ELSE title END,
					title_source = CASE WHEN title_source = 'default' AND ? IS NOT NULL THEN 'auto' ELSE title_source END,
					updated_at = ?, last_message_at = ?
				WHERE id = ?`)
				.run(
					userDisplayText ?? null,
					userDisplayText ? normalizeTitle(userDisplayText) : null,
					userDisplayText ?? null,
					now,
					latestText ? now : null,
					conversationId,
				);
		});
	}

	getLastConversationId(): string | undefined {
		return this.getSetting<string>("lastConversationId");
	}

	setLastConversationId(conversationId: string): void {
		this.setSetting("lastConversationId", conversationId);
		this.db.prepare("UPDATE conversations SET last_read_at = ? WHERE id = ?").run(Date.now(), conversationId);
	}

	renameConversation(conversationId: string, title: string): void {
		const normalized = title.trim();
		if (!normalized) throw new Error("对话名称不能为空");
		this.db
			.prepare("UPDATE conversations SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?")
			.run(normalized, Date.now(), conversationId);
	}

	setConversationPinned(conversationId: string, pinned: boolean): void {
		this.db
			.prepare("UPDATE conversations SET pinned_at = ?, updated_at = ? WHERE id = ?")
			.run(pinned ? Date.now() : null, Date.now(), conversationId);
	}

	archiveConversation(conversationId: string): void {
		this.db
			.prepare("UPDATE conversations SET archived_at = ?, updated_at = ? WHERE id = ?")
			.run(Date.now(), Date.now(), conversationId);
	}

	deleteConversation(conversationId: string): void {
		this.transaction(() => {
			this.db.prepare("DELETE FROM entry_search WHERE conversation_id = ?").run(conversationId);
			this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
		});
	}

	recoverInterruptedRuns(): void {
		const now = Date.now();
		this.transaction(() => {
			this.db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'").run(now);
			this.db
				.prepare("UPDATE conversations SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
				.run(now);
		});
	}

	importLegacySessions(options: LegacyImportDefaults): void {
		const root = options.sessionsDir ?? join(dirname(defaultConversationDatabasePath()), "sessions");
		let files: string[];
		try {
			files = collectJsonlFiles(root);
		} catch {
			return;
		}

		for (const filePath of files) {
			const content = readFileSync(filePath, "utf8");
			const sourceHash = createHash("sha256").update(content).digest("hex");
			const imported = this.db
				.prepare("SELECT source_hash FROM legacy_imports WHERE source_path = ? AND status = 'imported'")
				.get(filePath) as { source_hash: string } | undefined;
			if (imported?.source_hash === sourceHash) continue;

			try {
				const values = content
					.split(/\r?\n/)
					.filter(Boolean)
					.map((line) => JSON.parse(line) as unknown);
				const header = values.find(
					(value): value is LegacyHeader =>
						isRecord(value) &&
						value.type === "session" &&
						typeof value.id === "string" &&
						typeof value.cwd === "string",
				);
				if (!header) throw new Error("缺少有效的 session header");

				let previousId: string | null = null;
				const entries = values
					.filter((value): value is Record<string, unknown> => isRecord(value) && value.type !== "session")
					.map((value, index): SessionEntryRecord => {
						const id = typeof value.id === "string" ? value.id : `legacy-${index}`;
						const entry: SessionEntryRecord = {
							...value,
							type: typeof value.type === "string" ? value.type : "custom",
							id,
							parentId: typeof value.parentId === "string" ? value.parentId : previousId,
							timestamp:
								typeof value.timestamp === "string"
									? value.timestamp
									: (header.timestamp ?? new Date().toISOString()),
						};
						previousId = id;
						return entry;
					});
				const project =
					header.cwd && header.cwd !== options.freeChatCwd
						? { path: header.cwd, name: header.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? header.cwd }
						: undefined;
				const detail = this.createConversation(
					{ provider: options.provider, model: options.model, project },
					`legacy:${header.id}:${sourceHash.slice(0, 12)}`,
				);
				const firstUserText = entries.find((entry) => entryRole(entry) === "user");
				this.syncEntries(detail.id, entries, firstUserText ? messageText(firstUserText) : undefined);
				this.db
					.prepare(`INSERT INTO legacy_imports
						(source_path, source_hash, transcript_id, status, error_message, imported_at)
						VALUES (?, ?, ?, 'imported', NULL, ?)
						ON CONFLICT(source_path) DO UPDATE SET source_hash = excluded.source_hash,
						transcript_id = excluded.transcript_id, status = 'imported', error_message = NULL,
						imported_at = excluded.imported_at`)
					.run(filePath, sourceHash, detail.transcriptId, Date.now());
			} catch (error) {
				this.db
					.prepare(`INSERT INTO legacy_imports
						(source_path, source_hash, transcript_id, status, error_message, imported_at)
						VALUES (?, ?, NULL, 'failed', ?, ?)
						ON CONFLICT(source_path) DO UPDATE SET source_hash = excluded.source_hash,
						status = 'failed', error_message = excluded.error_message, imported_at = excluded.imported_at`)
					.run(filePath, sourceHash, error instanceof Error ? error.message : String(error), Date.now());
			}
		}
	}

	private readConversationRow(conversationId: string): ConversationRecord {
		const row = this.db
			.prepare(`SELECT c.id, c.title, c.provider, c.model, c.status, c.created_at, c.updated_at,
				c.pinned_at, c.archived_at, c.current_transcript_id,
				p.name AS project_name, p.path AS project_path,
				(SELECT e.searchable_text FROM entries e
				 WHERE e.transcript_id = c.current_transcript_id AND e.searchable_text IS NOT NULL
				 ORDER BY e.sequence DESC LIMIT 1) AS last_message_preview
			FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ?`)
			.get(conversationId) as unknown as ConversationRecord | undefined;
		if (!row?.current_transcript_id) throw new Error("对话不存在");
		return row;
	}

	private upsertProject(project: SelectedProject, now: number): string {
		const normalizedPath = resolve(project.path);
		const existing = this.db.prepare("SELECT id FROM projects WHERE path = ?").get(normalizedPath) as
			| { id: string }
			| undefined;
		if (existing) {
			this.db
				.prepare("UPDATE projects SET name = ?, last_opened_at = ? WHERE id = ?")
				.run(project.name, now, existing.id);
			return existing.id;
		}
		const id = randomUUID();
		this.db
			.prepare("INSERT INTO projects (id, path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)")
			.run(id, normalizedPath, project.name, now, now);
		return id;
	}

	private getSetting<T>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as
			| SettingRow
			| undefined;
		return row ? (JSON.parse(row.value_json) as T) : undefined;
	}

	private setSetting(key: string, value: unknown): void {
		this.db
			.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
			.run(key, JSON.stringify(value), Date.now());
	}

	private transaction<T>(callback: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
