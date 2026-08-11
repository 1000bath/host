/**
 * host client — programmatic access for a coding agent.
 *
 * Works against any host server. Also usable via plain HTTP/curl from any
 * agent runtime (opencode, claude code, aider, codex, ...).
 */

import type { HostMessage, HostReadOptions, HostSendOptions } from "./host.js";

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

	/** Global read-only log. */
	log(opts?: HostReadOptions): Promise<HostMessage[]> {
		return this.get("/log", opts).then((body) => body.messages as HostMessage[]);
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

	private get<T = any>(path: string, query?: HostReadOptions): Promise<T> {
		const qs = new URLSearchParams();
		if (query?.topic) qs.set("topic", query.topic);
		if (query?.after) qs.set("after", query.after);
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