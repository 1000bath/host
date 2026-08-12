import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHostServer, type HostServer } from "./server.js";

describe("host MCP server over stdio", () => {
	let server: HostServer;
	let url: string;
	let dir: string;

	function openMcp(): {
		request: (id: number, method: string, params?: unknown) => Promise<unknown>;
		notify: (method: string, params?: unknown) => void;
		kill: () => void;
	} {
		const child = spawn("node", [join(import.meta.dirname, "..", "dist", "cli.js"), "mcp", "--name", "agent-a", "--url", url], {
			stdio: ["pipe", "pipe", "inherit"],
		});
		const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
		createInterface({ input: child.stdout!, crlfDelay: Infinity }).on("line", (line) => {
			if (line.trim() === "") return;
			const reply = JSON.parse(line) as { id?: number; error?: { message: string }; result?: unknown };
			if (reply.id === undefined) return;
			const entry = pending.get(reply.id);
			if (!entry) return;
			pending.delete(reply.id);
			if (reply.error) entry.reject(new Error(reply.error.message));
			else entry.resolve(reply.result);
		});

		return {
			request: (id, method, params) =>
				new Promise((resolve, reject) => {
					pending.set(id, { resolve, reject });
					child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
				}),
			notify: (method, params) =>
				child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n"),
			kill: () => child.kill(),
		};
	}

	beforeAll(async () => {
		server = await startHostServer({ port: 0 });
		url = `http://127.0.0.1:${server.port}`;
		dir = await mkdtemp(join(tmpdir(), "host-mcp-"));
	});

	afterAll(async () => {
		await server.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("completes the MCP handshake and lists tools", async () => {
		const mcp = openMcp();
		try {
			const init = await mcp.request(1, "initialize", {});
			expect(init).toMatchObject({
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
			});

			mcp.notify("notifications/initialized");

			const list = await mcp.request(2, "tools/list");
			const names = ((list as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
			expect(names).toEqual(
				expect.arrayContaining(["register", "unregister", "agents", "send", "broadcast", "inbox", "log"]),
			);
		} finally {
			mcp.kill();
		}
	}, 15000);

	it("registers, sends, broadcasts, and drains via tools", async () => {
		const mcp = openMcp();
		try {
			// second agent to talk to
			const other = new (await import("./client.js")).HostClient({ baseUrl: url, name: "agent-b" });
			await other.register();

			await mcp.request(10, "tools/call", { name: "register", arguments: {} });

			const agents = await mcp.request(11, "tools/call", { name: "agents", arguments: {} });
			expect(JSON.stringify(agents)).toContain("agent-b");

			await mcp.request(12, "tools/call", {
				name: "send",
				arguments: { to: "agent-b", content: "hello from MCP" },
			});

			const inbox = await other.inbox();
			expect(inbox).toHaveLength(1);
			expect(inbox[0].content).toBe("hello from MCP");
			expect(inbox[0].to).toBe("agent-b");

			await mcp.request(13, "tools/call", {
				name: "broadcast",
				arguments: { content: { status: "shipping" }, topic: "ops" },
			});

			const logResult = await mcp.request(14, "tools/call", { name: "log", arguments: {} });
			expect(JSON.stringify(logResult)).toContain("shipping");
		} finally {
			mcp.kill();
		}
	}, 15000);

	it("reports tool errors as isError with message", async () => {
		const mcp = openMcp();
		try {
			// send to an unregistered agent (agent-c never registered) -> host 400
			const result = await mcp.request(20, "tools/call", {
				name: "send",
				arguments: { to: "ghost", content: "nope" },
			});
			const text = (result as { content: { text: string }[] }).content[0].text;
			expect(text).toContain("error");
		} finally {
			mcp.kill();
		}
	}, 15000);
});