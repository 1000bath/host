/**
 * host — job/status state machine.
 *
 * A Job is a unit of work with an explicit lifecycle the host owns, instead
 * of free-form messages:
 *
 *   open → claimed → done | failed
 *
 * - `open`: created by a dispatcher, not yet taken.
 * - `claimed`: an agent has accepted; only the claimant may transition it.
 * - `done`: claimant finished and delivered the work.
 * - `failed`: claimant abandoned or errored; it becomes open again for retry.
 *
 * Mutations are guarded: only the claimant can mark done/fail, claims are
 * single-winner, and only a failed/claimed job can be transitioned.
 */

export type JobStatus = "open" | "claimed" | "done" | "failed";

export interface Job {
	id: string;
	title: string;
	description?: string;
	topic?: string;
	status: JobStatus;
	assignee?: string;
	createdBy: string;
	createdAt: number;
	claimedAt?: number;
	completedAt?: number;
	result?: unknown;
	error?: string;
}

export interface JobCreateInput {
	title: string;
	description?: string;
	topic?: string;
	assignedTo?: string;
}

const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
	open: ["claimed"],
	claimed: ["done", "failed"],
	done: [],
	failed: ["claimed"],
};

function assertTransition(from: JobStatus, to: JobStatus): void {
	if (!TRANSITIONS[from].includes(to)) {
		throw new Error(`job: invalid transition ${from} -> ${to}`);
	}
}

/** In-memory job registry. Swap for a durable store behind the same API later. */
export class JobRegistry {
	protected readonly jobs = new Map<string, Job>();
	protected nextId = 0;

	/** Create a job in the `open` state. */
	create(input: JobCreateInput, createdBy: string): Job {
		if (input.title.trim() === "") throw new Error("job: title required");
		const job: Job = {
			id: String(++this.nextId),
			title: input.title,
			...(input.description !== undefined ? { description: input.description } : {}),
			...(input.topic !== undefined ? { topic: input.topic } : {}),
			status: "open",
			...(input.assignedTo !== undefined ? { assignee: input.assignedTo } : {}),
			createdBy,
			createdAt: Date.now(),
		};
		this.jobs.set(job.id, job);
		return job;
	}

	/** Claim an open job. Single-winner: already-claimed/done jobs are rejected. */
	claim(id: string, assignee: string): Job {
		const job = this.require(id);
		if (job.status !== "open") throw new Error(`job ${id}: not open (${job.status})`);
		if (job.assignee !== undefined && job.assignee !== assignee) {
			// assigned jobs may only be claimed by their assignee
			throw new Error(`job ${id}: reserved for ${job.assignee}`);
		}
		job.status = "claimed";
		job.assignee = assignee;
		job.claimedAt = Date.now();
		return job;
	}

	/** Mark a claimed job done. Only the claimant may do this. */
	done(id: string, by: string, result?: unknown): Job {
		const job = this.require(id);
		assertTransition(job.status, "done");
		if (job.assignee !== by) throw new Error(`job ${id}: only ${job.assignee} may complete`);
		job.status = "done";
		job.completedAt = Date.now();
		if (result !== undefined) job.result = result;
		return job;
	}

	/** Mark a claimed job failed. Only the claimant may do this. Returns to open for retry. */
	fail(id: string, by: string, error?: string): Job {
		const job = this.require(id);
		assertTransition(job.status, "failed");
		if (job.assignee !== by) throw new Error(`job ${id}: only ${job.assignee} may fail it`);
		job.status = "failed";
		job.error = error;
		// reset for retry: back to open, assignee may be re-bound on next claim
		job.status = "open";
		job.assignee = undefined;
		job.claimedAt = undefined;
		job.error = error;
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	/** List jobs, optionally filtered by status / assignee / topic. */
	list(opts: { status?: JobStatus; assignee?: string; topic?: string } = {}): Job[] {
		const all = [...this.jobs.values()];
		return all.filter(
			(job) =>
				(opts.status === undefined || job.status === opts.status) &&
				(opts.assignee === undefined || job.assignee === opts.assignee) &&
				(opts.topic === undefined || job.topic === opts.topic),
		);
	}

	/** @internal Load a pre-existing job into memory (used by persistent hosts). */
	protected seed(job: Job): void {
		this.jobs.set(job.id, job);
		const n = Number(job.id);
		if (n > this.nextId) this.nextId = n;
	}

	private require(id: string): Job {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`job ${id}: not found`);
		return job;
	}
}