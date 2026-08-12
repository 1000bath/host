#!/usr/bin/env node
/**
 * host CLI — lets any coding agent (opencode, claude code, aider, codex, ...)
 * talk through a shared host from the shell:
 *
 *   host serve              start the relay (default port 4777)
 *   host mcp [--name A]     expose the host as MCP tools over stdio (agent identity = A)
 *   host register --name A
 *   host send --from A --to B --content "..." [--topic t]
 *   host send --from A --to B --content-file brief.json   (or any file path)
 *   host broadcast --from A --content "..."
 *   host inbox --name A [--after id] [--topic t]
 *   host log [--after id]
 *   host watch --name A     live messages for A
 *   host agents
 *
 * Channel isolation (topic permission):
 *   host channel new --topic secret --name owner
 *   host channel add --topic secret --member bob --name owner
 *   host channel remove --topic secret --member bob --name owner
 *   host channel list
 *
 * Job workflow (status state machine):
 *   host job new --title "PKCE" --desc ... [--topic auth] [--assignee codex]
 *   host job list [--status open|claimed|done|failed] [--assignee A] [--topic t]
 *   host job claim --id 1 --name codex
 *   host job done --id 1 --name codex [--result "..."]
 *   host job fail --id 1 --name codex [--error "..."]
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { HostClient } from "./client.js";
import { runMcpServer } from "./mcp.js";
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

/** Content from --content-file (file path), falling back to --content. */
async function resolveContent(args: any): Promise<unknown> {
	const filePath = args.values["content-file"];
	if (filePath !== undefined) {
		const text = await readFile(filePath, "utf8");
		return contentOf(text);
	}
	return contentOf(args.values.content ?? "");
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
			jobTtlMs: args.values["job-ttl"] !== undefined ? Number(args.values["job-ttl"]) : undefined,
		});
		console.log(`host listening on http://${args.values.hostname ?? "0.0.0.0"}:${server.port}`);
		// keep running; Ctrl-C to stop
		await server.promise;
	},

	mcp: async (args) => {
		// The MCP server is one agent identity talking to a running host.
		// register() happens lazily on first tool use via the client name.
		const c = client(args);
		await runMcpServer(c);
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
		const message = await c.send(opt(args.values.to, ""), await resolveContent(args), {
			topic: args.values.topic,
		});
		console.log(JSON.stringify(message));
	},

	broadcast: async (args) => {
		const c = client(args);
		const message = await c.broadcast(await resolveContent(args), {
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
		printMessages(
			await c.log({
				topic: args.values.topic,
				after: args.values.after,
				as: args.values.as,
			}),
		);
	},

	watch: async (args) => {
		const c = client(args);
		const name = opt(args.values.name, "agent");
		c.watch(name, (message) => console.log(JSON.stringify(message)));
		console.log(`watching ${name}`);
		// wait indefinitely
		await new Promise(() => {});
	},

	channel: async (args) => {
		const sub = (args.positionals[1] as string) ?? "help";
		const c = client(args);
		switch (sub) {
			case "new": {
				const channel = await c.manageChannel(opt(args.values.topic, ""));
				console.log(JSON.stringify({ topic: channel.topic, owner: channel.owner, members: [...channel.members] }));
				return;
			}
			case "add": {
				const channel = await c.addChannelMember(opt(args.values.topic, ""), opt(args.values.member, ""));
				console.log(JSON.stringify({ topic: channel.topic, owner: channel.owner, members: [...channel.members] }));
				return;
			}
			case "remove": {
				const channel = await c.removeChannelMember(opt(args.values.topic, ""), opt(args.values.member, ""));
				console.log(JSON.stringify({ topic: channel.topic, owner: channel.owner, members: [...channel.members] }));
				return;
			}
			case "list": {
				for (const ch of await c.listChannels()) {
					console.log(JSON.stringify({ topic: ch.topic, owner: ch.owner, members: [...ch.members] }));
				}
				return;
			}
			default:
				console.error("usage: host channel <new|add|remove|list>");
				process.exit(1);
		}
	},

	workflow: async (args) => {
		const sub = (args.positionals[1] as string) ?? "help";
		const c = client(args);
		switch (sub) {
			case "new": {
				const steps = (opt(args.values.steps, ""))
					.split("|")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
					.map((title) => ({ title }));
				if (steps.length === 0) throw new Error("workflow: --steps 'A|B|C' required");
				const wf = await c.createWorkflow({ title: opt(args.values.title, "workflow"), steps });
				console.log(JSON.stringify(wf));
				return;
			}
			case "list": {
				for (const wf of await c.listWorkflows()) console.log(JSON.stringify(wf));
				return;
			}
			case "get": {
				console.log(JSON.stringify(await c.getWorkflow(opt(args.values.id, ""))));
				return;
			}
			default:
				console.error("usage: host workflow <new|list|get>");
				process.exit(1);
		}
	},

	job: async (args) => {
		const sub = (args.positionals[1] as string) ?? "help";
		const c = client(args);
		switch (sub) {
			case "new": {
				const job = await c.createJob({
					title: opt(args.values.title, ""),
					...(args.values.desc !== undefined ? { description: args.values.desc } : {}),
					...(args.values.topic !== undefined ? { topic: args.values.topic } : {}),
					...(args.values.assignee !== undefined ? { assignedTo: args.values.assignee } : {}),
				});
				console.log(JSON.stringify(job));
				return;
			}
			case "list": {
				const jobs = await c.listJobs({
					...(args.values.status !== undefined ? { status: args.values.status } : {}),
					...(args.values.assignee !== undefined ? { assignee: args.values.assignee } : {}),
					...(args.values.topic !== undefined ? { topic: args.values.topic } : {}),
				});
				for (const job of jobs) console.log(JSON.stringify(job));
				return;
			}
			case "claim": {
				const job = await c.claimJob(opt(args.values.id, ""));
				console.log(JSON.stringify(job));
				return;
			}
			case "done": {
				const job = await c.completeJob(
					opt(args.values.id, ""),
					args.values.result !== undefined ? contentOf(args.values.result) : undefined,
				);
				console.log(JSON.stringify(job));
				return;
			}
			case "fail": {
				const job = await c.failJob(opt(args.values.id, ""), args.values.error);
				console.log(JSON.stringify(job));
				return;
			}
			default:
				console.error("usage: host job <new|list|claim|done|fail>");
				process.exit(1);
		}
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
			"content-file": { type: "string" },
			title: { type: "string" },
			desc: { type: "string" },
			assignee: { type: "string" },
			id: { type: "string" },
			result: { type: "string" },
			error: { type: "string" },
			status: { type: "string" },
			"job-ttl": { type: "string" },
			member: { type: "string" },
			as: { type: "string" },
			steps: { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const command = positionals[0] ?? "help";
	const run = commands[command];
	if (!run) {
		console.error("usage: host <serve|mcp|register|unregister|agents|send|broadcast|inbox|log|watch|job>");
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