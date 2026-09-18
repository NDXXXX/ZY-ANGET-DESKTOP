import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, type SessionEntryRecord } from "../src/main/conversation-store.ts";

describe("ConversationStore", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
	});

	it("persists multiple conversations and restores their messages", () => {
		const directory = join(tmpdir(), `ddclaw-store-${crypto.randomUUID()}`);
		mkdirSync(directory, { recursive: true });
		directories.push(directory);
		const databasePath = join(directory, "ddclaw.sqlite");
		const store = new ConversationStore(databasePath);
		const first = store.createConversation({ model: "model", provider: "provider" });
		const second = store.createConversation({ model: "model", provider: "provider" });
		const timestamp = new Date().toISOString();
		const entries: SessionEntryRecord[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "raw prompt" },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "saved answer" }] },
			},
		];
		store.syncEntries(first.id, entries, "visible prompt");
		store.setConversationPinned(first.id, true);
		store.close();

		const reopened = new ConversationStore(databasePath);
		expect(reopened.listConversations().map((conversation) => conversation.id)).toEqual([first.id, second.id]);
		expect(reopened.getConversation(first.id).messages.map((message) => message.content)).toEqual([
			"visible prompt",
			"saved answer",
		]);
		expect(reopened.getSessionEntries(first.id)).toEqual(entries);
		reopened.close();
	});
});
