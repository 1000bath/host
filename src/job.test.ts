import { describe, expect, it } from "vitest";
import { JobRegistry } from "./job.js";

describe("JobRegistry state machine", () => {
	it("creates jobs in open status with a stable id", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "PKCE the auth module", description: "S256", topic: "auth" }, "clew");

		expect(job.status).toBe("open");
		expect(job.createdBy).toBe("clew");
		expect(job.topic).toBe("auth");
		expect(reg.get(job.id)).toBe(job);
	});

	it("claims an open job and binds the assignee", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t" }, "clew");

		const claimed = reg.claim(job.id, "codex");
		expect(claimed.status).toBe("claimed");
		expect(claimed.assignee).toBe("codex");
		expect(claimed.claimedAt).toBeDefined();
	});

	it("rejects claiming a non-open job", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t" }, "clew");
		reg.claim(job.id, "codex");
		expect(() => reg.claim(job.id, "claude")).toThrow(/not open/);
	});

	it("only the claimant can mark done or fail", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t" }, "clew");
		reg.claim(job.id, "codex");

		expect(() => reg.done(job.id, "claude")).toThrow(/only codex/);
		expect(() => reg.fail(job.id, "claude")).toThrow(/only codex/);

		const done = reg.done(job.id, "codex", { ok: true });
		expect(done.status).toBe("done");
		expect(done.result).toEqual({ ok: true });
		expect(done.completedAt).toBeDefined();
	});

	it("invalid transition (done -> fail) is rejected", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t" }, "clew");
		reg.claim(job.id, "codex");
		reg.done(job.id, "codex");
		expect(() => reg.fail(job.id, "codex")).toThrow(/invalid transition/);
	});

	it("fail returns the job to open for retry", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t" }, "clew");
		reg.claim(job.id, "codex");

		const failed = reg.fail(job.id, "codex", "crash");
		expect(failed.status).toBe("open");
		expect(failed.assignee).toBeUndefined();
		expect(failed.error).toBe("crash");
	});

	it("reserved jobs can only be claimed by their assignee", () => {
		const reg = new JobRegistry();
		const job = reg.create({ title: "t", assignedTo: "claude" }, "clew");
		expect(() => reg.claim(job.id, "codex")).toThrow(/reserved for claude/);
		expect(reg.claim(job.id, "claude").assignee).toBe("claude");
	});

	it("lists jobs filtered by status / assignee / topic", () => {
		const reg = new JobRegistry();
		const a = reg.create({ title: "a", topic: "auth" }, "clew");
		const b = reg.create({ title: "b", topic: "ops" }, "clew");
		reg.claim(a.id, "codex");
		reg.claim(b.id, "claude");

		expect(reg.list({ status: "claimed" })).toHaveLength(2);
		expect(reg.list({ assignee: "codex" })).toHaveLength(1);
		expect(reg.list({ topic: "ops" })).toHaveLength(1);
		expect(reg.list({ status: "open" })).toHaveLength(0);
	});
});