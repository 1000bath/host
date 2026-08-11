#!/usr/bin/env node
/**
 * host CLI — lets any coding agent (opencode, claude code, aider, codex, ...)
 * talk through a shared host from the shell:
 *
 *   host serve              start the relay (default port 4777)
 *   host register --name A
 *   host send --from A --to B --content "..." [--topic t]
 *   host broadcast --from A --content "..."
 *   host inbox --name A [--after id] [--topic t]
 *   host log [--after id]
 *   host watch --name A     live messages for A
 *   host agents
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { HostClient } from "./client.js";
import { startHostServer } from "./server.js";

const DEFAULT_PORT = 4777;

function opt(value: string | undefined, fallback: string): string {
	return value ?? fallback;
}

function contentOf(raw: string): unknown {
	const trimmed = raw.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			return JSON.parse(trimmed);
		} catch {
			// not JSON, keep as string
		}
	}
	return raw;
}

function client(args: any): HostClient {
	const defaultBase = `http://127.0.0.1:${Number(opt(args.values.port, String(DEFAULT_PORT)))}`;
	const name = opt(args.values.name, opt(args.values.from, "agent"));
	return new HostClient({ baseUrl: opt(args.values.url, defaultBase), name });
}

function printMessages(messages: any[]): void {
	for (const message of messages) {
		console.log(JSON.stringify(message));
	}
}

const commands: Record<string, (args: any) => Promise<void>> = {
	serve: async (args) => {
		const port = Number(opt(args.values.port, String(DEFAULT_PORT)));
		const server = await startHostServer({
			port,
			hostname: args.values.hostname ?? "0.0.0.0",
			dbPath: args.values.db,
		});
		console.log(`host listening on http://${args.values.hostname ?? "0.0.0.0"}:${server.port}`);
		// keep running; Ctrl-C to stop
		await server.promise;
	},

	register: async (args) => {
		const c = client(args);
		await c.register();
		console.log("registered");
	},

	unregister: async (args) => {
		const c = client(args);
		await c.unregister();
		console.log("unregistered");
	},

	agents: async (args) => {
		const c = client(args);
		for (const name of await c.agents()) console.log(name);
	},

	send: async (args) => {
		const c = client(args);
		const message = await c.send(opt(args.values.to, ""), contentOf(opt(args.values.content, "")), {
			topic: args.values.topic,
		});
		console.log(JSON.stringify(message));
	},

	broadcast: async (args) => {
		const c = client(args);
		const message = await c.broadcast(contentOf(opt(args.values.content, "")), {
			topic: args.values.topic,
		});
		console.log(JSON.stringify(message));
	},

	inbox: async (args) => {
		const c = client(args);
		const messages = await c.inbox({ topic: args.values.topic, after: args.values.after });
		printMessages(messages);
	},

	log: async (args) => {
		const c = client(args);
		printMessages(await c.log({ topic: args.values.topic, after: args.values.after }));
	},

	watch: async (args) => {
		const c = client(args);
		const name = opt(args.values.name, "agent");
		c.watch(name, (message) => console.log(JSON.stringify(message)));
		console.log(`watching ${name}`);
		// wait indefinitely
		await new Promise(() => {});
	},
};

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			name: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			content: { type: "string" },
			topic: { type: "string" },
			after: { type: "string" },
			port: { type: "string" },
			url: { type: "string" },
			hostname: { type: "string" },
			db: { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const command = positionals[0] ?? "help";
	const run = commands[command];
	if (!run) {
		console.error("usage: host <serve|register|unregister|agents|send|broadcast|inbox|log|watch>");
		process.exit(1);
	}
	try {
		await run({ values, positionals });
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

const isMain =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
	main();
}