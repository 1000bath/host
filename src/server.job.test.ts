import { afterEach, describe, expect, it } from "vitest";
import { HostClient } from "./client.js";
import { startHostServer, type HostServer } from "./server.js";

describe("host job API over HTTP", () => {
	let server: HostServer;
	const servers: HostServer[] = [];

	async function start(): Promise<void> {
		const s = await startHostServer({ port: 0 });
		servers.push(s);
		server = s;
	}

	afterEach(async () => {
		await Promise.all(servers.map((s) => s.close()));
		servers.length = 0;
	});

	it("runs a full job lifecycle: create -> claim -> done", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;
		const dispatcher = new HostClient({ baseUrl: url, name: "clew" });
		const worker = new HostClient({ baseUrl: url, name: "codex" });
		await dispatcher.register();
		await worker.register();

		const job = await dispatcher.createJob({
			title: "Implement PKCE",
			description: "S256 challenge",
			topic: "auth",
		});
		expect(job.status).toBe("open");

		const claimed = await worker.claimJob(job.id);
		expect(claimed.status).toBe("claimed");
		expect(claimed.assignee).toBe("codex");

		const done = await worker.completeJob(job.id, { outline: "..." });
		expect(done.status).toBe("done");
		expect(done.result).toEqual({ outline: "..." });

		// visible under status filter
		const doneJobs = await dispatcher.listJobs({ status: "done" });
		expect(doneJobs).toHaveLength(1);
	});

	it("rejects a second claim and non-claimant completion", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;
		const clew = new HostClient({ baseUrl: url, name: "clew" });
		const codex = new HostClient({ baseUrl: url, name: "codex" });
		const claude = new HostClient({ baseUrl: url, name: "claude" });

		const job = await clew.createJob({ title: "t" });
		await codex.claimJob(job.id);

		await expect(claude.claimJob(job.id)).rejects.toThrow(/not open/);
		await expect(claude.completeJob(job.id)).rejects.toThrow(/only codex/);
	});

	it("fail returns a job to open for retry", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;
		const clew = new HostClient({ baseUrl: url, name: "clew" });
		const codex = new HostClient({ baseUrl: url, name: "codex" });

		const job = await clew.createJob({ title: "t" });
		await codex.claimJob(job.id);
		const failed = await codex.failJob(job.id, "worker crash");

		expect(failed.status).toBe("open");
		// another worker can claim it again
		const claude = new HostClient({ baseUrl: url, name: "claude" });
		expect((await claude.claimJob(job.id)).assignee).toBe("claude");
	});

	it("errors surface as non-2xx with JSON body", async () => {
		await start();
		const url = `http://127.0.0.1:${server.port}`;
		const clew = new HostClient({ baseUrl: url, name: "clew" });

		await expect(clew.claimJob("999")).rejects.toThrow(/not found/);
		await expect(clew.createJob({ title: "" })).rejects.toThrow(/title required/);
	});
});