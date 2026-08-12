/**
 * host — SQLite persistence.
 *
 * Uses Node 24's built-in `node:sqlite` (DatabaseSync), so the zero-runtime-
 * dependency invariant holds. A PersistentHost subclasses Host and mirrors
 * every mutation to disk: messages are append-only, pending mailbox rows track
 * what each agent has not yet read, and agents persist as plain rows.
 */

import { DatabaseSync } from "node:sqlite";
import { Host, type HostMessage, type HostReadOptions, type HostSendInput, Mailbox } from "./host.js";
import { JobRegistry, type Job } from "./job.js";

interface MessageRow {
	id: number;
	ts: number;
	from: string;
	to: string | null;
	topic: string | null;
	content: string;
}

function serialized(content: unknown): string {
	return JSON.stringify(content === undefined ? null : content);
}

function deserialize(row: MessageRow): HostMessage {
	return {
		id: String(row.id),
		ts: row.ts,
		from: row.from,
		...(row.to !== null ? { to: row.to } : {}),
		...(row.topic !== null ? { topic: row.topic } : {}),
		content: JSON.parse(row.content),
	};
}

/** SQLite-backed store. Holds the schema and all read/write statements. */
export class SqliteStore {
	readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS agents (
				name TEXT PRIMARY KEY
			);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY,
				ts INTEGER NOT NULL,
				from_name TEXT NOT NULL,
				to_name TEXT,
				topic TEXT,
				content TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS pending (
				name TEXT NOT NULL,
				message_id INTEGER NOT NULL,
				PRIMARY KEY (name, message_id),
				FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
			);
			CREATE TABLE IF NOT EXISTS jobs (
				id INTEGER PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT,
				topic TEXT,
				status TEXT NOT NULL,
				assignee TEXT,
				created_by TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				claimed_at INTEGER,
				completed_at INTEGER,
				result TEXT,
				error TEXT
			);
		`);
	}

	// ---- jobs ----

	saveJob(job: Job): void {
		this.db
			.prepare(
				`INSERT INTO jobs (id, title, description, topic, status, assignee, created_by,
				 created_at, claimed_at, completed_at, result, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					title = excluded.title, description = excluded.description, topic = excluded.topic,
					status = excluded.status, assignee = excluded.assignee, created_by = excluded.created_by,
					created_at = excluded.created_at, claimed_at = excluded.claimed_at,
					completed_at = excluded.completed_at, result = excluded.result, error = excluded.error`,
			)
			.run(
				Number(job.id),
				job.title,
				job.description ?? null,
				job.topic ?? null,
				job.status,
				job.assignee ?? null,
				job.createdBy,
				job.createdAt,
				job.claimedAt ?? null,
				job.completedAt ?? null,
				job.result === undefined ? null : JSON.stringify(job.result),
				job.error ?? null,
			);
	}

	loadJobs(): Job[] {
		const rows = this.db.prepare("SELECT * FROM jobs ORDER BY id ASC").all() as unknown as Array<{
			id: number;
			title: string;
			description: string | null;
			topic: string | null;
			status: string;
			assignee: string | null;
			created_by: string;
			created_at: number;
			claimed_at: number | null;
			completed_at: number | null;
			result: string | null;
			error: string | null;
		}>;
		return rows.map((row) => ({
			id: String(row.id),
			title: row.title,
			...(row.description !== null ? { description: row.description } : {}),
			...(row.topic !== null ? { topic: row.topic } : {}),
			status: row.status as Job["status"],
			...(row.assignee !== null ? { assignee: row.assignee } : {}),
			createdBy: row.created_by,
			createdAt: row.created_at,
			...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
			...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
			...(row.result !== null ? { result: JSON.parse(row.result) } : {}),
			...(row.error !== null ? { error: row.error } : {}),
		}));
	}

	close(): void {
		this.db.close();
	}

	agents(): string[] {
		return this.db.prepare("SELECT name FROM agents ORDER BY name").all().map((r) => (r as { name: string }).name);
	}

	saveAgent(name: string): void {
		this.db.prepare("INSERT OR IGNORE INTO agents (name) VALUES (?)").run(name);
	}

	deleteAgent(name: string): void {
		this.db.prepare("DELETE FROM agents WHERE name = ?").run(name);
	}

	maxId(): number {
		const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").get() as {
			max_id: number;
		};
		return row.max_id;
	}

	private static readonly MESSAGE_COLUMNS = 'id, ts, from_name AS "from", to_name AS "to", topic, content';

	messages(): HostMessage[] {
		const rows = this.db
			.prepare(`SELECT ${SqliteStore.MESSAGE_COLUMNS} FROM messages ORDER BY id ASC`)
			.all() as unknown as MessageRow[];
		return rows.map(deserialize);
	}

	/** Messages that are still pending for a given agent, oldest first. */
	pending(name: string): HostMessage[] {
		const rows = this.db
			.prepare(
				`SELECT m.id, m.ts, m.from_name AS "from", m.to_name AS "to", m.topic, m.content
				 FROM pending p JOIN messages m ON m.id = p.message_id
				 WHERE p.name = ? ORDER BY m.id ASC`,
			)
			.all(name) as unknown as MessageRow[];
		return rows.map(deserialize);
	}

	/** Save a message and mark it pending for each recipient, atomically. */
	saveMessage(message: HostMessage, recipients: string[]): void {
		const insert = this.db.prepare(
			`INSERT INTO messages (id, ts, from_name, to_name, topic, content) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		const markPending = this.db.prepare("INSERT OR IGNORE INTO pending (name, message_id) VALUES (?, ?)");
		this.transaction(() => {
			insert.run(
				Number(message.id),
				message.ts,
				message.from,
				message.to ?? null,
				message.topic ?? null,
				serialized(message.content),
			);
			for (const recipient of recipients) {
				markPending.run(recipient, Number(message.id));
			}
		});
	}

	deletePending(name: string, messageIds: number[]): void {
		if (messageIds.length === 0) return;
		const deleteStmt = this.db.prepare("DELETE FROM pending WHERE name = ? AND message_id = ?");
		this.transaction(() => {
			for (const id of messageIds) deleteStmt.run(name, id);
		});
	}

	private transaction(fn: () => void): void {
		this.db.exec("BEGIN");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}

/**
 * Host backed by SQLite. Mirrors the in-memory state onto disk on every
 * mutation, and reloads it on construction — so restarting the process keeps
 * agents, the message log, and undelivered mailbox queues.
 */
/** JobRegistry mirrored to SQLite — jobs survive restarts alongside messages. */
export class PersistentJobRegistry extends JobRegistry {
	constructor(private readonly store: SqliteStore) {
		super();
		for (const job of store.loadJobs()) this.seed(job);
	}

	override create(input: Parameters<JobRegistry["create"]>[0], createdBy: string): Job {
		const job = super.create(input, createdBy);
		this.store.saveJob(job);
		return job;
	}

	override claim(id: string, assignee: string): Job {
		const job = super.claim(id, assignee);
		this.store.saveJob(job);
		return job;
	}

	override done(id: string, by: string, result?: unknown): Job {
		const job = super.done(id, by, result);
		this.store.saveJob(job);
		return job;
	}

	override fail(id: string, by: string, error?: string): Job {
		const job = super.fail(id, by, error);
		this.store.saveJob(job);
		return job;
	}
}

export class PersistentHost extends Host {
	private readonly store: SqliteStore;
	readonly jobs: PersistentJobRegistry;

	constructor(dbPath: string) {
		super();
		this.store = new SqliteStore(dbPath);
		this.load();
		this.jobs = new PersistentJobRegistry(this.store);
	}

	private load(): void {
		for (const name of this.store.agents()) {
			// populate mailboxes without touching disk
			this.mailboxes.set(name, new Mailbox(this, name));
		}
		for (const message of this.store.messages()) {
			this.all.push(message);
		}
		for (const name of this.mailboxes.keys()) {
			for (const message of this.store.pending(name)) {
				this.mailboxes.get(name)!._push(message);
			}
		}
		this.nextId = this.store.maxId();
	}

	override register(name: string): Mailbox {
		const mailbox = super.register(name);
		this.store.saveAgent(name);
		return mailbox;
	}

	override unregister(name: string): void {
		super.unregister(name);
		this.store.deleteAgent(name);
	}

	override send(input: HostSendInput): HostMessage {
		const message = super.send(input);
		const recipients =
			message.to !== undefined
				? [message.to]
				: this.list().filter((name) => name !== message.from);
		this.store.saveMessage(message, recipients);
		return message;
	}

	override read(name: string, opts: HostReadOptions = {}): HostMessage[] {
		const drained = super.read(name, opts);
		this.store.deletePending(name, drained.map((m) => Number(m.id)));
		return drained;
	}

	close(): void {
		this.store.close();
	}
}