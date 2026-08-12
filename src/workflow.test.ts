import { describe, expect, it } from "vitest";
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
});