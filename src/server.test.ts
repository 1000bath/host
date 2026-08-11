import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "./client.js";
import { startHostServer, type HostServer } from "./server.js";

describe("host server over HTTP", () => {
	let server: HostServer;
	const servers: HostServer[] = [];

	async function start(): Promise<HostServer> {
		const s = await startHostServer({ port: 0 });
		servers.push(s);
		server = s;
		return s;
	}

	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		servers.length = 0;
	});

	it("registers agents, sends, and drains inboxes over HTTP", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;

		const alice = new HostClient({ baseUrl: url, name: "alice" });
		const bob = new HostClient({ baseUrl: url, name: "bob" });

		await alice.register();
		await bob.register();

		expect(await alice.agents()).toEqual(["alice", "bob"]);

		await alice.send("bob", "ping", { topic: "test" });
		expect(await alice.inbox()).toHaveLength(0);
		expect(await bob.inbox()).toHaveLength(1);

		// drained
		expect(await bob.inbox()).toHaveLength(0);
	});

	it("broadcast is visible in everyone's inbox except sender's", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;

		const alice = new HostClient({ baseUrl: url, name: "alice" });
		const bob = new HostClient({ baseUrl: url, name: "bob" });

		await alice.register();
		await bob.register();

		await alice.broadcast("hi all", { topic: "general" });

		expect(await bob.inbox()).toHaveLength(1);
		expect(await alice.inbox()).toHaveLength(0);
	});

	it("global log records every message", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;

		const alice = new HostClient({ baseUrl: url, name: "alice" });
		await alice.register();
		await alice.send("alice", "self-note");
		await alice.broadcast("to the room");

		const log = await alice.log();
		expect(log).toHaveLength(2);
	});

	it("SSE stream pushes live messages for a watched agent", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;

		const alice = new HostClient({ baseUrl: url, name: "alice" });
		const bob = new HostClient({ baseUrl: url, name: "bob" });
		await alice.register();
		await bob.register();

		const received: string[] = [];
		const stop = alice.watch("bob", (m) => received.push(String(m.content)));

		// SSE connects asynchronously; give it a beat, then send
		await new Promise((r) => setTimeout(r, 100));
		await alice.send("bob", "live update");

		// wait for the pushed event
		await new Promise((r) => setTimeout(r, 150));
		await stop();

		expect(received).toContain("live update");
	});

	it("returns 400 with a JSON error for bad send targets", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;

		const alice = new HostClient({ baseUrl: url, name: "alice" });
		await alice.register();

		await expect(alice.send("ghost", "nope")).rejects.toThrow(/not registered/);
	});
});