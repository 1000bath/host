/**
 * host client — programmatic access for a coding agent.
 *
 * Works against any host server. Also usable via plain HTTP/curl from any
 * agent runtime (opencode, claude code, aider, codex, ...).
 */

import type { Channel, HostMessage, HostReadOptions, HostSendOptions } from "./host.js";
import type { Job, JobStatus } from "./job.js";
import type { Workflow, WorkflowStep } from "./workflow.js";

export interface HostClientOptions {
	baseUrl?: string;
	port?: number;
	/** Sender identity used by send()/broadcast(). */
	name: string;
}

const DEFAULT_PORT = 4777;

export class HostClient {
	private readonly baseUrl: string;
	readonly name: string;

	constructor(options: HostClientOptions) {
		this.baseUrl = options.baseUrl ?? `http://127.0.0.1:${options.port ?? DEFAULT_PORT}`;
		this.name = options.name;
	}

	/** Register this agent with the host. Idempotent server-side. */
	async register(): Promise<void> {
		await this.post("/agents", { name: this.name });
	}

	async unregister(): Promise<void> {
		await fetch(`${this.baseUrl}/agents/${encodeURIComponent(this.name)}`, {
			method: "DELETE",
		}).then(check);
	}

	/** Names of all registered agents. */
	agents(): Promise<string[]> {
		return this.get("/agents").then((body) => body.agents as string[]);
	}

	/** Send a message to another agent. */
	send(to: string, content: unknown, opts?: HostSendOptions): Promise<HostMessage> {
		return this.post("/send", { from: this.name, to, content, ...opts });
	}

	/** Send a message to every agent except this one. */
	broadcast(content: unknown, opts?: HostSendOptions): Promise<HostMessage> {
		return this.post("/send", { from: this.name, content, ...opts });
	}

	/** Read-and-drain this agent's pending messages. */
	inbox(opts?: HostReadOptions): Promise<HostMessage[]> {
		return this.get(`/inbox/${encodeURIComponent(this.name)}`, opts).then(
			(body) => body.messages as HostMessage[],
		);
	}

	/** Global read-only log. Pass `as` to hide channels you're not a member of. */
	log(opts?: HostReadOptions): Promise<HostMessage[]> {
		return this.get("/log", opts).then((body) => body.messages as HostMessage[]);
	}

	// ---- channels (topic isolation) ----

	/** Restrict a topic into a channel owned by this client. */
	manageChannel(topic: string): Promise<Channel> {
		return this.post("/channels", { topic, owner: this.name });
	}

	/** Add an agent to a channel (only the channel owner may do this). */
	addChannelMember(topic: string, agent: string): Promise<Channel> {
		return this.post(`/channels/${encodeURIComponent(topic)}/members/${encodeURIComponent(agent)}`, {
			by: this.name,
		});
	}

	/** Remove an agent from a channel (only the channel owner may do this). */
	removeChannelMember(topic: string, agent: string): Promise<Channel> {
		return fetch(
			`${this.baseUrl}/channels/${encodeURIComponent(topic)}/members/${encodeURIComponent(agent)}?by=${encodeURIComponent(this.name)}`,
			{ method: "DELETE" },
		)
			.then(check)
			.then((body) => body as Channel);
	}

	/** List all managed channels. */
	listChannels(): Promise<Channel[]> {
		return this.get("/channels").then((body) => body.channels as Channel[]);
	}

	// ---- jobs (status state machine) ----

	createJob(input: {
		title: string;
		description?: string;
		topic?: string;
		assignedTo?: string;
	}): Promise<Job> {
		return this.post("/jobs", { ...input, createdBy: this.name });
	}

	/** List jobs, optionally filtered by status / assignee / topic. */
	listJobs(opts?: { status?: JobStatus; assignee?: string; topic?: string }): Promise<Job[]> {
		return this.get("/jobs", opts).then((body) => body.jobs as Job[]);
	}

	getJob(id: string): Promise<Job> {
		return this.get(`/jobs/${id}`);
	}

	/** Claim an open job for this agent. Single-winner. */
	claimJob(id: string): Promise<Job> {
		return this.post(`/jobs/${id}/claimed`, { assignee: this.name });
	}

	/** Mark a claimed job done with an optional result. Only the claimant. */
	completeJob(id: string, result?: unknown): Promise<Job> {
		return this.post(`/jobs/${id}/done`, { by: this.name, ...(result !== undefined ? { result } : {}) });
	}

	/** Mark a claimed job failed (returns it to open for retry). Only the claimant. */
	failJob(id: string, error?: string): Promise<Job> {
		return this.post(`/jobs/${id}/failed`, { by: this.name, ...(error !== undefined ? { error } : {}) });
	}

	// ---- workflows (orchestrated pipelines) ----

	createWorkflow(input: { title: string; steps: WorkflowStep[] }): Promise<Workflow> {
		return this.post("/workflows", { ...input, createdBy: this.name });
	}

	listWorkflows(): Promise<Workflow[]> {
		return this.get("/workflows").then((body) => body.workflows as Workflow[]);
	}

	getWorkflow(id: string): Promise<Workflow> {
		return this.get(`/workflows/${id}`);
	}

	/**
	 * Subscribe to messages for one agent over SSE. Returns an unsubscribe fn.
	 * Messages already queued are not replayed — call inbox() to drain first.
	 */
	watch(name: string, onMessage: (message: HostMessage) => void): () => Promise<void> {
		const controller = new AbortController();
		void (async () => {
			try {
				const res = await fetch(`${this.baseUrl}/stream?name=${encodeURIComponent(name)}`, {
					signal: controller.signal,
				});
				if (!res.body) return;
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const events = buffer.split("\n\n");
					buffer = events.pop() ?? "";
					for (const event of events) {
						const data = event
							.split("\n")
							.filter((line) => line.startsWith("data: "))
							.map((line) => line.slice(6))
							.join("\n");
						if (data.trim() !== "" && !data.startsWith(":")) {
							onMessage(JSON.parse(data) as HostMessage);
						}
					}
				}
			} catch {
				// aborted or connection closed
			}
		})();
		return () => {
			controller.abort();
			return Promise.resolve();
		};
	}

	private get<T = any>(
		path: string,
		query?: { topic?: string; after?: string; status?: string; assignee?: string; as?: string },
	): Promise<T> {
		const qs = new URLSearchParams();
		if (query?.topic) qs.set("topic", query.topic);
		if (query?.after) qs.set("after", query.after);
		if (query?.status) qs.set("status", query.status);
		if (query?.assignee) qs.set("assignee", query.assignee);
		if (query?.as) qs.set("as", query.as);
		const full = `${this.baseUrl}${path}${qs.size > 0 ? `?${qs}` : ""}`;
		return fetch(full).then(check).then((body) => body as T);
	}

	private post<T = any>(path: string, body: unknown): Promise<T> {
		return fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
			.then(check)
			.then((body) => body as T);
	}
}

async function check(res: Response): Promise<unknown> {
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`host error ${res.status}: ${text}`);
	}
	return res.json();
}