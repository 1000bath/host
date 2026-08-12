/**
 * host — Model Context Protocol server.
 *
 * Lets coding agents (claude code, opencode, codex, ...) drive the host
 * through MCP tools over stdio instead of shelling out to the CLI. Speaks the
 * MCP protocol (JSON-RPC 2.0, newline-delimited) with zero dependencies.
 *
 * Wire it up in any agent:
 *   "mcpServers": { "host": { "command": "host", "args": ["mcp"] } }
 */

import { createInterface } from "node:readline";
import type { HostClient } from "./client.js";
import type { HostMessage, HostReadOptions } from "./host.js";

interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string };
}

const TOOLS: McpTool[] = [
	{
		name: "register",
		description: "Register this agent (the MCP server's identity) on the host. Idempotent.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "unregister",
		description: "Remove this agent from the host and drop its pending messages.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "agents",
		description: "List all registered agent names on the host.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "send",
		description: "Send a message from this agent to another.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Recipient name" },
				content: { description: "Message content (any JSON)" },
				topic: { type: "string", description: "Optional group/channel key" },
			},
			required: ["to", "content"],
		},
	},
	{
		name: "broadcast",
		description: "Send a message from this agent to every other registered agent.",
		inputSchema: {
			type: "object",
			properties: {
				content: { description: "Message content (any JSON)" },
				topic: { type: "string", description: "Optional group/channel key" },
			},
			required: ["content"],
		},
	},
	{
		name: "inbox",
		description: "Read-and-drain pending messages for this agent.",
		inputSchema: {
			type: "object",
			properties: {
				topic: { type: "string" },
				after: { type: "string", description: "Only messages with id strictly after this" },
			},
		},
	},
	{
		name: "log",
		description: "Read the global message log (read-only, does not drain).",
		inputSchema: {
			type: "object",
			properties: {
				topic: { type: "string" },
				after: { type: "string", description: "Only messages with id strictly after this" },
			},
		},
	},
	{
		name: "job_create",
		description: "Create a new job for the shared work queue (status: open).",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Job title" },
				description: { type: "string" },
				topic: { type: "string" },
				assignedTo: { type: "string", description: "Optional reserved assignee" },
			},
			required: ["title"],
		},
	},
	{
		name: "job_list",
		description: "List jobs in the shared work queue, optionally filtered.",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", description: "open|claimed|done|failed" },
				assignee: { type: "string" },
				topic: { type: "string" },
			},
		},
	},
	{
		name: "job_claim",
		description: "Claim an open job for this agent. Single-winner.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
	},
	{
		name: "job_done",
		description: "Mark a claimed job done with an optional result. Only the claimant.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, result: { description: "Optional result payload" } },
			required: ["id"],
		},
	},
	{
		name: "job_fail",
		description: "Mark a claimed job failed (returns it to open for retry). Only the claimant.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, error: { type: "string" } },
			required: ["id"],
		},
	},
];

function response(id: number | string, result: unknown): JsonRpcMessage {
	return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: number | string, code: number, message: string): JsonRpcMessage {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Run the MCP server on stdio against a connected HostClient. */
export async function runMcpServer(client: HostClient): Promise<void> {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.trim() === "") continue;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			process.stdout.write(JSON.stringify(errorResponse(0, -32700, "parse error")) + "\n");
			continue;
		}

		const reply = await handleMessage(message, client);
		if (reply) {
			process.stdout.write(JSON.stringify(reply) + "\n");
		}
	}
}

/** Handle a single JSON-RPC message. Returns the reply, or undefined for notifications. */
export async function handleMessage(
	message: JsonRpcMessage,
	client: HostClient,
): Promise<JsonRpcMessage | undefined> {
	if (message.method === undefined || message.id === undefined) {
		return undefined; // notification or response, nothing to answer
	}
	const params = message.params ?? {};
	const { method, id } = message;

	switch (method) {
		case "initialize":
			return response(id, {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "host", version: "0.1.0" },
			});

		case "ping":
			return response(id, {});

		case "tools/list":
			return response(id, { tools: TOOLS });

		case "tools/call": {
			const name = params.name as string;
			const args = (params.arguments ?? {}) as Record<string, unknown>;
			const tool = TOOLS.find((t) => t.name === name);
			if (!tool) return errorResponse(id, -32602, `unknown tool: ${name}`);
			try {
				const result = await callTool(client, name, args);
				return response(id, {
					content: [{ type: "text", text: JSON.stringify(result) }],
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				return response(id, { content: [{ type: "text", text: `error: ${text}` }], isError: true });
			}
		}

		case "notifications/initialized":
			return undefined;

		default:
			return errorResponse(id, -32601, `method not found: ${method}`);
	}
}

async function callTool(client: HostClient, name: string, args: Record<string, unknown>): Promise<unknown> {
	const str = (key: string): string | undefined =>
		typeof args[key] === "string" ? (args[key] as string) : undefined;

	switch (name) {
		case "register":
			await client.register();
			return { ok: true };

		case "unregister":
			await client.unregister();
			return { ok: true };

		case "agents":
			return { agents: await client.agents() };

		case "send":
			return client.send(str("to") ?? "", args.content, { topic: str("topic") });

		case "broadcast":
			return client.broadcast(args.content, { topic: str("topic") });

		case "inbox": {
			const opts: HostReadOptions = {
				topic: str("topic"),
				after: str("after"),
			};
			return { messages: await client.inbox(opts) };
		}

		case "log": {
			const opts: HostReadOptions = { topic: str("topic"), after: str("after") };
			return { messages: await client.log(opts) };
		}

		case "job_create":
			return client.createJob({
				title: str("title") ?? "",
				...(args.description !== undefined ? { description: String(args.description) } : {}),
				...(args.topic !== undefined && typeof args.topic === "string" ? { topic: args.topic } : {}),
				...(args.assignedTo !== undefined && typeof args.assignedTo === "string"
					? { assignedTo: args.assignedTo }
					: {}),
			});

		case "job_list":
			return {
				jobs: await client.listJobs({
					...(typeof args.status === "string" ? { status: args.status as any } : {}),
					...(typeof args.assignee === "string" ? { assignee: args.assignee } : {}),
					...(typeof args.topic === "string" ? { topic: args.topic } : {}),
				}),
			};

		case "job_claim":
			return client.claimJob(str("id") ?? "");

		case "job_done":
			return client.completeJob(str("id") ?? "", args.result);

		case "job_fail":
			return client.failJob(str("id") ?? "", str("error"));

		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

export type { HostMessage };
