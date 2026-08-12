import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PersistentJobRegistry, SqliteStore } from "./persist.js";
import { WorkflowRegistry } from "./workflow.js";

describe("WorkflowRegistry orchestration", () => {
	it("releases only the first step at creation", () => {
		const reg = new WorkflowRegistry();
		const wf = reg.createWorkflow(
			{ title: "Ship", steps: [{ title: "Build" }, { title: "Test" }, { title: "Deploy" }] },
			"clew",
		);

		expect(wf.status).toBe("active");
		expect(wf.steps).toHaveLength(3);

		// only step 1 has a released job
		const open = reg.list({ status: "open" });
		expect(open).toHaveLength(1);
		expect(open[0].title).toBe("Build");
		expect(wf.steps[0].jobId).toBe(open[0].id);
		// steps 2-3 have no job yet
		expect(wf.steps[1].jobId).toBeUndefined();
		expect(wf.steps[2].jobId).toBeUndefined();
	});

	it("advances one step at a time as each job is completed", () => {
		const reg = new WorkflowRegistry();
		const wf = reg.createWorkflow(
			{ title: "Ship", steps: [{ title: "Build" }, { title: "Test" }, { title: "Deploy" }] },
			"clew",
		);

		// Step 1: codex claims + completes
		const s1 = reg.list({ status: "open" })[0];
		reg.claim(s1.id, "codex");
		reg.done(s1.id, "codex");
		expect(wf.steps[0].status).toBe("done");

		// Step 2 auto-open now
		const nowOpen = reg.list({ status: "open" });
		expect(nowOpen).toHaveLength(1);
		expect(nowOpen[0].title).toBe("Test");

		// Step 2: claude claims + completes
		reg.claim(nowOpen[0].id, "claude");
		reg.done(nowOpen[0].id, "claude");

		// Step 3 auto-open
		const s3 = reg.list({ status: "open" })[0];
		expect(s3.title).toBe("Deploy");

		// Complete final step
		reg.claim(s3.id, "codex");
		reg.done(s3.id, "codex");
		expect(wf.status).toBe("done");
		expect(wf.completedAt).toBeDefined();
		expect(wf.steps.every((s) => s.status === "done")).toBe(true);
	});

	it("a workflow step can reserve an assignee", () => {
		const reg = new WorkflowRegistry();
		reg.createWorkflow(
			{ title: "Review", steps: [{ title: "Code", assignedTo: "codex" }, { title: "Review", assignedTo: "claude" }] },
			"clew",
		);

		const s1 = reg.list({ status: "open" })[0];
		expect(s1.assignee).toBe("codex");
		// a different agent cannot claim the reserved step
		expect(() => reg.claim(s1.id, "claude")).toThrow(/reserved/);
	});

	it("lists workflows and exposes step job linkage", () => {
		const reg = new WorkflowRegistry();
		const wf = reg.createWorkflow({ title: "Mini", steps: [{ title: "A" }] }, "clew");

		expect(reg.listWorkflows()).toHaveLength(1);
		expect(reg.getWorkflow(wf.id)).toBe(wf);
		expect(wf.steps[0].jobId).toBeDefined();
	});

	it("a step's assignedTo is respected at both release and advance", () => {
		const reg = new WorkflowRegistry();
		reg.createWorkflow(
			{ title: "Chain", steps: [{ title: "One", assignedTo: "alice" }, { title: "Two", assignedTo: "bob" }] },
			"clew",
		);

		// step 1 released with alice reserved
		const s1 = reg.list({ status: "open" })[0];
		expect(s1.assignee).toBe("alice");
		reg.claim(s1.id, "alice");
		reg.done(s1.id, "alice");

		// step 2 auto-released with bob reserved
		const s2 = reg.list({ status: "open" })[0];
		expect(s2.title).toBe("Two");
		expect(s2.assignee).toBe("bob");
		expect(() => reg.claim(s2.id, "alice")).toThrow(/reserved/);
	});
});

describe("workflow persistence", () => {
	let dir: string;
	let dbPath: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "wf-persist-"));
		dbPath = join(dir, "wf.db");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("persists workflows and their progress across restart", () => {
		// first process: create workflow, advance one step
		const store1 = new SqliteStore(dbPath);
		const reg1 = new PersistentJobRegistry(store1);
		const wf = reg1.createWorkflow(
			{ title: "Ship", steps: [{ title: "Build", assignedTo: "codex" }, { title: "Deploy" }] },
			"clew",
		);
		const s1 = reg1.list({ status: "open" })[0];
		reg1.claim(s1.id, "codex");
		reg1.done(s1.id, "codex");
		store1.close();

		// second process: same file, workflow state restored at step 2
		const store2 = new SqliteStore(dbPath);
		const reg2 = new PersistentJobRegistry(store2);

		const restored = reg2.getWorkflow(wf.id)!;
		expect(restored.status).toBe("active");
		expect(restored.steps[0].status).toBe("done");
		expect(restored.steps[1].status).toBe("open");
		expect(restored.steps[0].jobId).toBe(s1.id);

		// the released step-2 job is open and adoptable
		const s2 = reg2.list({ status: "open" })[0];
		expect(s2.title).toBe("Deploy");

		// completing step 2 finishes the workflow, persisted
		reg2.claim(s2.id, "claude");
		reg2.done(s2.id, "claude");
		store2.close();

		const store3 = new SqliteStore(dbPath);
		const reg3 = new PersistentJobRegistry(store3);
		expect(reg3.getWorkflow(wf.id)?.status).toBe("done");
		store3.close();
	});
});