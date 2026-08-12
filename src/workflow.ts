/**
 * host — workflow orchestration.
 *
 * A Workflow is an ordered list of steps. The host releases them one at a
 * time: step _N_ becomes an open job only after step _N−1_ is done. This
 * composes the job queue into a pipeline that agents work through in order.
 *
 * Built on JobRegistry: each step is a Job, and completing a step's job
 * unlocks (creates) the next step's job.
 */

import { JobRegistry, type Job, type JobCreateInput } from "./job.js";

interface WorkflowStep {
	title: string;
	description?: string;
	topic?: string;
	/** Optional reserved assignee for this step. */
	assignedTo?: string;
}

export interface WorkflowStepState {
	step: number;
	title: string;
	description?: string;
	topic?: string;
	assignedTo?: string;
	jobId?: string;
	status: "open" | "claimed" | "done" | "failed";
}

export interface Workflow {
	id: string;
	title: string;
	steps: WorkflowStepState[];
	status: "active" | "done" | "failed";
	createdBy: string;
	createdAt: number;
	completedAt?: number;
}

/**
 * A JobRegistry that can also run ordered workflows. When a job belonging to
 * the currently-released step of a workflow is marked done, the next step's
 * job is created and released.
 */
export class WorkflowRegistry extends JobRegistry {
	private readonly workflows = new Map<string, { wf: Workflow; stepIndex: number }>();
	// workflow id -> currently released (open/claimed) step's jobId
	private readonly activeJobToWf = new Map<string, string>();

	/** Create a workflow and release step 1. Returns the workflow. */
	createWorkflow(input: { title: string; steps: WorkflowStep[] }, createdBy: string): Workflow {
		if (input.title.trim() === "") throw new Error("workflow: title required");
		if (input.steps.length === 0) throw new Error("workflow: at least one step required");
		if (input.steps.some((step) => step.title.trim() === "")) {
			throw new Error("workflow: every step requires a title");
		}
		const id = String(++this.nextId);
		const wf: Workflow = {
			id,
			title: input.title,
			steps: input.steps.map((s, i) => ({
				step: i + 1,
				title: s.title,
				...(s.description !== undefined ? { description: s.description } : {}),
				...(s.topic !== undefined ? { topic: s.topic } : {}),
				...(s.assignedTo !== undefined ? { assignedTo: s.assignedTo } : {}),
				status: "open",
			})),
			status: "active",
			createdBy,
			createdAt: this.now(),
		};
		this.workflows.set(id, { wf, stepIndex: 0 });
		this.releaseStep(id, 0, wf.steps[0]);
		this.persistWorkflow(wf);
		return wf;
	}

	getWorkflow(id: string): Workflow | undefined {
		return this.workflows.get(id)?.wf;
	}

	listWorkflows(): Workflow[] {
		return [...this.workflows.values()].map((e) => e.wf);
	}

	/**
	 * Persistence hook: called after a workflow is created or advances.
	 * In-memory WorkflowRegistry does nothing; a persistent subclass writes to storage.
	 */
	protected persistWorkflow(_wf: Workflow): void {}

	/**
	 * @internal Restore a workflow into memory without persisting (used on load).
	 * The current step's job id is wired into the active-job map so completing
	 * it advances the pipeline.
	 */
	restoreWorkflow(wf: Workflow): void {
		const stepIndex = Math.max(
			0,
			wf.steps.findIndex((s) => s.status !== "done"),
		);
		this.workflows.set(wf.id, { wf, stepIndex });
		const current = wf.steps[stepIndex];
		if (current?.jobId && wf.status === "active") {
			this.activeJobToWf.set(current.jobId, wf.id);
		}
	}

	override done(id: string, by: string, result?: unknown): Job {
		const job = super.done(id, by, result);
		// completing a workflow step may release the next one
		const wfId = this.activeJobToWf.get(job.id);
		if (wfId) this.advanceWorkflow(wfId, job.id);
		return job;
	}

	private releaseStep(wfId: string, index: number, step: WorkflowStepState): void {
		const entry = this.workflows.get(wfId)!;
		const wf = entry.wf;
		const jobInput: JobCreateInput = {
			title: step.title,
			...(step.description !== undefined ? { description: step.description } : {}),
			...(step.topic !== undefined ? { topic: step.topic } : {}),
			...(step.assignedTo !== undefined ? { assignedTo: step.assignedTo } : {}),
		};
		// use `this.create` so a persistent subclass's override also records the job
		const job = this.create(jobInput, wf.createdBy);
		wf.steps[index].status = "open";
		wf.steps[index].jobId = job.id;
		this.activeJobToWf.set(job.id, wfId);
	}

	private advanceWorkflow(wfId: string, doneJobId: string): void {
		const entry = this.workflows.get(wfId);
		if (!entry) return;
		const wf = entry.wf;
		const doneIndex = entry.stepIndex;
		entry.stepIndex += 1;

		// mark the completed step done in the workflow view
		if (wf.steps[doneIndex]) {
			wf.steps[doneIndex].status = "done";
		}
		this.activeJobToWf.delete(doneJobId);

		// release next step, or finish
		const nextIndex = doneIndex + 1;
		if (nextIndex < wf.steps.length) {
			this.releaseStep(wfId, nextIndex, wf.steps[nextIndex]);
		} else {
			wf.status = "done";
			wf.completedAt = this.now();
		}
		this.persistWorkflow(wf);
	}
}

export type { WorkflowStep };
