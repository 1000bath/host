/**
 * HTTP/SSE server exposing a Host over the wire.
 * Built on node:http only — no framework, no deps.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Host, type Channel, type HostMessage, type HostReadOptions, type HostSendInput } from "./host.js";
import { JobRegistry, type JobStatus } from "./job.js";
import { PersistentHost } from "./persist.js";
import { WorkflowRegistry } from "./workflow.js";

export interface HostServerOptions {
	host?: Host;
	/** Job registry; defaults to a fresh in-memory workflow-capable registry. */
	jobs?: WorkflowRegistry;
	port?: number;
	hostname?: string;
	/** SQLite file path for durable storage. Omit for in-memory. */
	dbPath?: string;
	/**
	 * Auto-reassign: a job claimed this many ms with no done/fail is reopened
	 * for another worker. Swept periodically. Omit to disable.
	 */
	jobTtlMs?: number;
}

export interface HostServer {
	host: Host;
	jobs: WorkflowRegistry;
	port: number;
	promise: Promise<void>;
	close(): Promise<void>;
}

const JSON_HEADER = "application/json; charset=utf-8";

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": JSON_HEADER });
	res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	return text === "" ? undefined : JSON.parse(text);
}

function readQuery(url: URL): HostReadOptions {
	return {
		topic: url.searchParams.get("topic") ?? undefined,
		after: url.searchParams.get("after") ?? undefined,
	};
}

/** Route a message from an SSE stream to a connected agent. Matches mailbox delivery semantics. */
function isForAgent(message: HostMessage, name: string): boolean {
	return message.to === name || (message.to === undefined && message.from !== name);
}

function channelToJson(channel: Channel) {
	return {
		topic: channel.topic,
		owner: channel.owner,
		members: [...channel.members],
	};
}

function readJobQuery(url: URL) {
	return {
		status: (url.searchParams.get("status") as JobStatus | null) ?? undefined,
		assignee: url.searchParams.get("assignee") ?? undefined,
		topic: url.searchParams.get("topic") ?? undefined,
	};
}

function handle(req: IncomingMessage, res: ServerResponse, host: Host, jobs: JobRegistry): void {
	void (async () => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname;

		try {
			if (req.method === "GET" && path === "/") {
				json(res, 200, { name: "host", agents: host.list() });
				return;
			}

			if (req.method === "GET" && path === "/agents") {
				json(res, 200, { agents: host.list() });
				return;
			}

			if (req.method === "POST" && path === "/agents") {
				const body = (await readJson(req)) as { name?: string } | undefined;
				const name = body?.name;
				if (!name) throw new Error("register: name required");
				host.register(name);
				json(res, 200, { ok: true });
				return;
			}

			if (req.method === "DELETE" && path.startsWith("/agents/")) {
				host.unregister(decodeURIComponent(path.slice("/agents/".length)));
				json(res, 200, { ok: true });
				return;
			}

			if (req.method === "POST" && path === "/send") {
				const body = (await readJson(req)) as HostSendInput;
				const message = host.send(body);
				json(res, 200, message);
				return;
			}

			if (req.method === "GET" && path.startsWith("/inbox/")) {
				const name = decodeURIComponent(path.slice("/inbox/".length));
				const messages = host.read(name, readQuery(url));
				json(res, 200, { messages });
				return;
			}

			if (req.method === "GET" && path === "/log") {
				json(res, 200, { messages: host.log({ ...readQuery(url), as: url.searchParams.get("as") ?? undefined }) });
				return;
			}

			// ---- channels (topic isolation) ----
			if (req.method === "POST" && path === "/channels") {
				const body = (await readJson(req)) as { topic?: string; owner?: string };
				if (!body?.topic) throw new Error("channels: topic required");
				json(res, 200, channelToJson(host.manageChannel(body.topic, body.owner ?? "unknown")));
				return;
			}

			const channelMatch = path.match(/^\/channels\/([^/]+)(?:\/members(?:\/([^/]+))?)?$/);
			if (channelMatch) {
				const topic = decodeURIComponent(channelMatch[1]);
				const member = channelMatch[2] ? decodeURIComponent(channelMatch[2]) : undefined;
				if (req.method === "GET") {
					const channel = host
						.listChannels()
						.find((c) => c.topic === topic);
					if (!channel) throw new Error(`channel ${topic}: not managed`);
					json(res, 200, channelToJson(channel));
					return;
				}
				if (member && req.method === "POST") {
					const body = (await readJson(req)) as { by?: string };
					if (!body?.by) throw new Error("channels: by required");
					json(res, 200, channelToJson(host.addChannelMember(topic, body.by, member)));
					return;
				}
				if (member && req.method === "DELETE") {
					const by = url.searchParams.get("by");
					if (!by) throw new Error("channels: ?by= required");
					json(res, 200, channelToJson(host.removeChannelMember(topic, by, member)));
					return;
				}
			}

			if (req.method === "GET" && path === "/channels") {
				json(res, 200, { channels: host.listChannels().map(channelToJson) });
				return;
			}

			// ---- workflows (orchestrated pipelines) ----
			if (req.method === "POST" && path === "/workflows") {
				const body = (await readJson(req)) as {
					title?: string;
					steps?: Array<{ title: string; description?: string; topic?: string; assignedTo?: string }>;
					createdBy?: string;
				};
				if (!body?.title || !Array.isArray(body.steps) || body.steps.length === 0) {
					throw new Error("workflows: title and steps[] required");
				}
				json(res, 200, (jobs as WorkflowRegistry).createWorkflow({
					title: body.title,
					steps: body.steps,
				}, body.createdBy ?? "unknown"));
				return;
			}

			if (req.method === "GET" && path === "/workflows") {
				json(res, 200, { workflows: (jobs as WorkflowRegistry).listWorkflows() });
				return;
			}

			const wfMatch = path.match(/^\/workflows\/(\d+)$/);
			if (wfMatch && req.method === "GET") {
				json(res, 200, (jobs as WorkflowRegistry).getWorkflow(wfMatch[1]) ?? { error: "not found" });
				return;
			}

			// ---- jobs (status state machine) ----
			if (req.method === "POST" && path === "/jobs") {
				const body = (await readJson(req)) as {
					title?: string;
					description?: string;
					topic?: string;
					assignedTo?: string;
					createdBy?: string;
				};
				if (!body?.title) throw new Error("jobs: title required");
				json(res, 200, jobs.create({
					title: body.title,
					...(body.description !== undefined ? { description: body.description } : {}),
					...(body.topic !== undefined ? { topic: body.topic } : {}),
					...(body.assignedTo !== undefined ? { assignedTo: body.assignedTo } : {}),
				}, body.createdBy ?? "unknown"));
				return;
			}

			if (req.method === "GET" && path === "/jobs") {
				json(res, 200, { jobs: jobs.list(readJobQuery(url)) });
				return;
			}

			const jobMatch = path.match(/^\/jobs\/(\d+)(?:\/(claimed|done|failed))?$/);
			if (jobMatch) {
				const id = jobMatch[1];
				const action = jobMatch[2];
				if (!action) {
					json(res, 200, jobs.get(id) ?? { error: "not found" });
					return;
				}
				const body = (await readJson(req)) as {
					by?: string;
					assignee?: string;
					result?: unknown;
					error?: string;
				};
				switch (action) {
					case "claimed": {
						if (!body?.assignee) throw new Error("jobs: assignee required");
						json(res, 200, jobs.claim(id, body.assignee));
						return;
					}
					case "done": {
						if (!body?.by) throw new Error("jobs: by required");
						json(res, 200, jobs.done(id, body.by, body.result));
						return;
					}
					case "failed": {
						if (!body?.by) throw new Error("jobs: by required");
						json(res, 200, jobs.fail(id, body.by, body.error));
						return;
					}
				}
			}

			if (req.method === "GET" && path === "/stream") {
				return stream(url, req, res, host);
			}

			json(res, 404, { error: `no such route: ${req.method} ${path}` });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			json(res, 400, { error: message });
		}
	})();
}

/** Server-Sent Events: pushes relayed messages for one agent (live "receive"). */
function stream(url: URL, req: IncomingMessage, res: ServerResponse, host: Host): void {
	const name = url.searchParams.get("name");
	if (!name) throw new Error("stream: name query param required");

	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	const unsubscribe = host.subscribe((message) => {
		if (isForAgent(message, name)) {
			res.write(`data: ${JSON.stringify(message)}\n\n`);
		}
	});

	// Comment heartbeat so proxies/curl don't close idle connections.
	const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
	req.on("close", () => {
		clearInterval(heartbeat);
		unsubscribe();
	});
}

export async function startHostServer(options: HostServerOptions = {}): Promise<HostServer> {
	const host = options.host ?? (options.dbPath ? new PersistentHost(options.dbPath, options) : new Host());
	const jobs =
		options.jobs ??
		(host instanceof PersistentHost
			? host.jobs
			: new WorkflowRegistry({ claimTtl: options.jobTtlMs }));
	const port = options.port ?? 4777;
	const hostname = options.hostname ?? "127.0.0.1";

	// Auto-reassign sweep: release claimed jobs past their TTL.
	// We notify the abandoned worker before reopenStale() clears assignee.
	let sweepTimer: NodeJS.Timeout | undefined;
	if (options.jobTtlMs) {
		sweepTimer = setInterval(() => {
			const now = Date.now();
			for (const job of jobs.list({ status: "claimed" })) {
				if (job.claimedAt && now - job.claimedAt > options.jobTtlMs! && job.assignee) {
					try {
						host.send({
							from: "host",
							to: job.assignee,
							content: { notice: "job timed out; reassigned", jobId: job.id },
							topic: "ops",
						});
					} catch {
						// worker may have unregistered; ignore the notify
					}
				}
			}
			jobs.reopenStale();
		}, Math.min(options.jobTtlMs / 2, 30_000));
	}

	const server = createServer((req, res) => handle(req, res, host, jobs));

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const actualPort = (server.address() as { port: number }).port;

	return {
		host,
		jobs,
		port: actualPort,
		promise: new Promise<void>((resolve) => server.on("close", resolve)),
		close: () => {
			if (sweepTimer) clearInterval(sweepTimer);
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}