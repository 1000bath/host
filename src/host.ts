/**
 * host — central message relay for coding agents.
 *
 * Zero runtime dependencies. In-memory only: an agent's pending messages are
 * held in its mailbox until read (drained), and a global read-only log keeps
 * every message for "what did everyone say" queries.
 */

/** A single message relayed through the host. */
export interface HostMessage {
	/** Monotonic id; also usable as a read cursor. */
	id: string;
	/** Sender name. */
	from: string;
	/** Recipient name. Omitted = broadcast to every mailbox except the sender. */
	to?: string;
	/** Optional group/channel key. */
	topic?: string;
	/** Arbitrary JSON payload (string or object). */
	content: unknown;
	/** Epoch millis. */
	ts: number;
}

export interface HostSendOptions {
	topic?: string;
	ts?: number;
}

export interface HostReadOptions {
	topic?: string;
	/** Only messages with id strictly after this cursor. */
	after?: string;
}

export interface HostSendInput extends HostSendOptions {
	from: string;
	to?: string;
	content: unknown;
}

/** Message sink for a single registered agent. */
export class Mailbox {
	private readonly pending: HostMessage[] = [];

	constructor(
		private readonly host: Host,
		public readonly name: string,
	) {}

	/** Send a message to another registered agent. */
	send(to: string, content: unknown, opts: HostSendOptions = {}): HostMessage {
		return this.host.send({ from: this.name, to, content, ...opts });
	}

	/** Send a message to every other registered agent. */
	broadcast(content: unknown, opts: HostSendOptions = {}): HostMessage {
		return this.host.send({ from: this.name, content, ...opts });
	}

	/** Read (and drain) this agent's pending messages. */
	read(opts: HostReadOptions = {}): HostMessage[] {
		return this.host.read(this.name, opts);
	}

	/** Number of pending (unread) messages. */
	get size(): number {
		return this.pending.length;
	}

	/** @internal */
	_push(message: HostMessage): void {
		this.pending.push(message);
	}

	/** @internal */
	_drain(opts: HostReadOptions): HostMessage[] {
		const drained: HostMessage[] = [];
		for (let i = this.pending.length - 1; i >= 0; i--) {
			const message = this.pending[i];
			if (matchesRead(message, opts)) {
				drained.unshift(...this.pending.splice(i, 1));
			}
		}
		return drained;
	}
}

function matchesRead(message: HostMessage, opts: HostReadOptions): boolean {
	if (opts.topic !== undefined && message.topic !== opts.topic) return false;
	if (opts.after !== undefined && Number(message.id) <= Number(opts.after)) return false;
	return true;
}

/** Central relay. Agents register, send, broadcast, read, and stream messages. */
export class Host {
	private readonly mailboxes = new Map<string, Mailbox>();
	private readonly all: HostMessage[] = [];
	private readonly subscribers = new Set<(message: HostMessage) => void>();
	private nextId = 0;

	/**
	 * Register an agent and return its mailbox. Idempotent: re-registering a
	 * name returns the existing mailbox so a restarting agent keeps its queue.
	 */
	register(name: string): Mailbox {
		const existing = this.mailboxes.get(name);
		if (existing) return existing;
		const mailbox = new Mailbox(this, name);
		this.mailboxes.set(name, mailbox);
		return mailbox;
	}

	/** Remove an agent and drop its pending messages. */
	unregister(name: string): void {
		this.mailboxes.delete(name);
	}

	/** Names of all registered agents. */
	list(): string[] {
		return [...this.mailboxes.keys()];
	}

	/** Send a message. `to` omitted = broadcast to all except the sender. */
	send(input: HostSendInput): HostMessage {
		const { from, to, content } = input;
		if (from.trim() === "") throw new Error("send: from required");
		if (to !== undefined) {
			if (!this.mailboxes.has(to)) {
				throw new Error(`send: agent "${to}" is not registered`);
			}
		}
		const message: HostMessage = {
			id: String(++this.nextId),
			from,
			...(to !== undefined ? { to } : {}),
			...(input.topic !== undefined ? { topic: input.topic } : {}),
			content,
			ts: input.ts ?? Date.now(),
		};
		this.all.push(message);

		if (to !== undefined) {
			this.mailboxes.get(to)!._push(message);
		} else {
			for (const [name, mailbox] of this.mailboxes) {
				if (name !== from) mailbox._push(message);
			}
		}

		for (const subscriber of this.subscribers) subscriber(message);
		return message;
	}

	/** Read (and drain) one agent's pending messages. */
	read(name: string, opts: HostReadOptions = {}): HostMessage[] {
		return this.mailboxes.get(name)?._drain(opts) ?? [];
	}

	/** Global read-only message log. */
	log(opts: HostReadOptions = {}): HostMessage[] {
		return this.all.filter((message) => matchesRead(message, opts));
	}

	/** Subscribe to every relayed message (used by the SSE stream). */
	subscribe(fn: (message: HostMessage) => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}
}