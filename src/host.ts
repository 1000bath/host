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
	/** Viewer identity: hides messages on channels the viewer is not a member of. */
	as?: string;
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

/** A restricted channel: a topic that only its members may send to or read. */
export interface Channel {
	topic: string;
	owner: string;
	members: Set<string>;
}

/** Central relay. Agents register, send, broadcast, read, and stream messages. */
export class Host {
	protected readonly mailboxes = new Map<string, Mailbox>();
	protected readonly all: HostMessage[] = [];
	private readonly subscribers = new Set<(message: HostMessage) => void>();
	protected nextId = 0;
	/** Restricted topics -> who may access them. Unmanaged topics are open to all. */
	protected readonly channels = new Map<string, Channel>();

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

	/**
	 * Restrict a topic into a channel. Only `owner` (the creator) may manage it.
	 * Once managed, only members can send to / read from that topic.
	 * Re-invoking re-lists the channel and returns it.
	 */
	manageChannel(topic: string, owner: string): Channel {
		const existing = this.channels.get(topic);
		if (existing) return existing;
		const channel: Channel = { topic, owner, members: new Set([owner]) };
		this.channels.set(topic, channel);
		return channel;
	}

	/** Add an agent to a channel. Only the channel owner may do this. */
	addChannelMember(topic: string, by: string, agent: string): Channel {
		const channel = this.requireChannel(topic);
		if (channel.owner !== by) throw new Error(`channel ${topic}: only ${channel.owner} may manage it`);
		channel.members.add(agent);
		return channel;
	}

	/** Remove an agent from a channel. Only the channel owner may do this. */
	removeChannelMember(topic: string, by: string, agent: string): Channel {
		const channel = this.requireChannel(topic);
		if (channel.owner !== by) throw new Error(`channel ${topic}: only ${channel.owner} may manage it`);
		channel.members.delete(agent);
		return channel;
	}

	/** All managed channels. */
	listChannels(): Channel[] {
		return [...this.channels.values()];
	}

	/** Is `agent` allowed to access `topic` (open topic, or member of its channel)? */
	canAccess(topic: string | undefined, agent: string): boolean {
		if (topic === undefined) return true;
		const channel = this.channels.get(topic);
		return channel === undefined || channel.members.has(agent);
	}

	private requireChannel(topic: string): Channel {
		const channel = this.channels.get(topic);
		if (!channel) throw new Error(`channel ${topic}: not managed`);
		return channel;
	}

	/** Send a message. `to` omitted = broadcast to all except the sender. */
	send(input: HostSendInput): HostMessage {
		const { from, to, content } = input;
		if (from.trim() === "") throw new Error("send: from required");
		if (!this.canAccess(input.topic, from)) {
			throw new Error(`send: ${from} is not a member of channel "${input.topic}"`);
		}
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
				if (name === from) continue;
				// broadcast on a restricted channel only reaches its members
				if (!this.canAccess(input.topic, name)) continue;
				mailbox._push(message);
			}
		}

		for (const subscriber of this.subscribers) subscriber(message);
		return message;
	}

	/** Read (and drain) one agent's pending messages. */
	read(name: string, opts: HostReadOptions = {}): HostMessage[] {
		if (!this.canAccess(opts.topic, name)) {
			throw new Error(`read: ${name} is not a member of channel "${opts.topic}"`);
		}
		return this.mailboxes.get(name)?._drain(opts) ?? [];
	}

	/**
	 * Global read-only message log.
	 * Set `as` to the viewer's agent name to hide messages on channels the
	 * viewer is not a member of. Without `as`, everything is visible (admin view).
	 */
	log(opts: HostReadOptions = {}): HostMessage[] {
		return this.all.filter((message) => {
			if (!matchesRead(message, opts)) return false;
			if (opts.as !== undefined && !this.canAccess(message.topic, opts.as)) return false;
			return true;
		});
	}

	/** Subscribe to every relayed message (used by the SSE stream). */
	subscribe(fn: (message: HostMessage) => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}
}