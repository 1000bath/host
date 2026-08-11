/**
 * HTTP/SSE server exposing a Host over the wire.
 * Built on node:http only — no framework, no deps.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Host, type HostMessage, type HostReadOptions, type HostSendInput } from "./host.js";
import { PersistentHost } from "./persist.js";

export interface HostServerOptions {
	host?: Host;
	port?: number;
	hostname?: string;
	/** SQLite file path for durable storage. Omit for in-memory. */
	dbPath?: string;
}

export interface HostServer {
	host: Host;
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

function handle(req: IncomingMessage, res: ServerResponse, host: Host): void {
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
				json(res, 200, { messages: host.log(readQuery(url)) });
				return;
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
	const host = options.host ?? (options.dbPath ? new PersistentHost(options.dbPath) : new Host());
	const port = options.port ?? 4777;
	const hostname = options.hostname ?? "127.0.0.1";

	const server = createServer((req, res) => handle(req, res, host));

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
		port: actualPort,
		promise: new Promise<void>((resolve) => server.on("close", resolve)),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}