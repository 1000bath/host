import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersistentHost, PersistentJobRegistry, SqliteStore } from "./persist.js";

describe("PersistentHost", () => {
	let dir: string;
	let dbPath: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "host-test-"));
		dbPath = join(dir, "host.db");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("persists agents, log, and pending mailboxes across restart", () => {
		// first process
		const host1 = new PersistentHost(dbPath);
		const alice = host1.register("alice");
		host1.register("bob");
		alice.send("bob", "remember me", { topic: "tasks" });
		alice.send("bob", "another one");
		alice.broadcast("everyone look");
		host1.close();

		// second process — same file
		const host2 = new PersistentHost(dbPath);
		expect(host2.list()).toEqual(expect.arrayContaining(["alice", "bob"]));
		expect(host2.log()).toHaveLength(3);

		const bobPending = host2.read("bob");
		expect(bobPending).toHaveLength(3); // 2 direct + 1 broadcast
		expect(bobPending[0].content).toBe("remember me");

		// drained stays drained after restart
		host2.close();
		const host3 = new PersistentHost(dbPath);
		expect(host3.read("bob")).toHaveLength(0);
		host3.close();
	});

	it("keeps message ids monotonic across restart", () => {
		const host1 = new PersistentHost(dbPath);
		const carol = host1.register("carol");
		carol.send("carol", "self note");
		host1.close();

		const host2 = new PersistentHost(dbPath);
		try {
			const next = host2.register("carol").send("carol", "after restart");
			const previous = Number(host2.log()[0].id);
			expect(Number(next.id)).toBeGreaterThan(previous);
		} finally {
			host2.close();
		}
	});

	it("preserves from/to/topic across restart", () => {
		const host1 = new PersistentHost(dbPath);
		const alice = host1.register("alice");
		host1.register("bob");
		alice.send("bob", "labeled", { topic: "tasks" });
		host1.close();

		const host2 = new PersistentHost(dbPath);
		const [message] = host2.log();
		expect(message.from).toBe("alice");
		expect(message.to).toBe("bob");
		expect(message.topic).toBe("tasks");
		host2.close();
	});

	it("does not deliver messages to a drained inbox after reload", () => {
		const host1 = new PersistentHost(dbPath);
		const alice = host1.register("alice");
		host1.register("bob");
		alice.send("bob", "read me");
		host1.read("bob"); // drains
		host1.close();

		const host2 = new PersistentHost(dbPath);
		expect(host2.read("bob")).toHaveLength(0);
		host2.close();
	});

	it("persists jobs across restart via PersistentJobRegistry", () => {
		const store = new SqliteStore(dbPath);
		const reg1 = new PersistentJobRegistry(store);
		const job = reg1.create({ title: "PKCE", topic: "auth" }, "clew");
		reg1.claim(job.id, "codex");
		reg1.done(job.id, "codex", { ok: true });
		store.close();

		const store2 = new SqliteStore(dbPath);
		const reg2 = new PersistentJobRegistry(store2);
		const loaded = reg2.get(job.id);
		expect(loaded?.status).toBe("done");
		expect(loaded?.assignee).toBe("codex");
		expect(loaded?.result).toEqual({ ok: true });
		store2.close();
	});

	it("persists failed jobs as open for retry after restart", () => {
		const store = new SqliteStore(dbPath);
		const reg1 = new PersistentJobRegistry(store);
		const job = reg1.create({ title: "flaky" }, "clew");
		reg1.claim(job.id, "codex");
		reg1.fail(job.id, "codex", "crash");
		store.close();

		const store2 = new SqliteStore(dbPath);
		const reg2 = new PersistentJobRegistry(store2);
		const loaded = reg2.get(job.id);
		expect(loaded?.status).toBe("open");
		expect(loaded?.assignee).toBeUndefined();
		expect(loaded?.error).toBe("crash");
		store2.close();
	});

	it("PersistentHost.jobs shares the same db file", () => {
		const host = new PersistentHost(dbPath);
		const job = host.jobs.create({ title: "via host" }, "clew");
		expect(host.jobs.get(job.id)).toBeDefined();
		host.close();
	});
});