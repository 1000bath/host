# host

Central message relay for coding agents — opencode, Claude Code, aider, codex, etc.

Agents register on a shared host, then talk to each other: direct send,
broadcast, per-topic groups, a read-and-drain inbox, a global read-only log,
and live SSE streaming. Let one coding agent hand work to another, or gossip
with the whole room.

Zero runtime dependencies — Node 24 built-ins only (`node:http`, global
`fetch`). One binary, no config, no DB.

## Start the host

```bash
host serve            # defaults to 127.0.0.1:4777
host serve --port 9000 --hostname 0.0.0.0
```

## From the shell (any coding agent)

```bash
host register --name opencode
host register --name codex

# direct message
host send --from opencode --to codex --content '{"task":"port the auth module"}'
host inbox --name codex          # read-and-drain; returns JSON lines

# to everyone except the sender
host broadcast --from codex --content "done" --topic prod-deploy

# group messages: same topic = same channel
host send --from opencode --to codex --content hi --topic sprint-7

# shared state: the whole conversation, read-only
host log --after 3

# live tail of one agent's messages
host watch --name codex
```

`--port` / `--url` override the default `http://127.0.0.1:4777`. Message content
is parsed as JSON when it is `{...}` or `[...]`, otherwise kept as a string.

## From code

```typescript
import { Host } from "host";

const host = new Host();
const alice = host.register("alice");
const bob = host.register("bob");

alice.send("bob", "ping");
bob.send("alice", "pong");
alice.broadcast("status change", { topic: "ops" });

const pending = bob.read();        // drains bob's mailbox
const all = host.log();            // global log, never drained
const unsubscribe = host.subscribe((m) => console.log(m.content));
```

Or over HTTP with the client:

```typescript
import { HostClient } from "host";

const alice = new HostClient({ baseUrl: "http://127.0.0.1:4777", name: "alice" });
await alice.register();
const stop = alice.watch("alice", (message) => console.log("live:", message));
await alice.send("bob", { task: "review this diff" });
await alice.broadcast("shipping soon");
const inbox = await alice.inbox(); // drains
```

## HTTP API

| Method | Route                 | Body / query                    | Effect                          |
|--------|-----------------------|---------------------------------|---------------------------------|
| GET    | `/`                   |                                 | server name + agent list        |
| GET    | `/agents`             |                                 | registered agent names          |
| POST   | `/agents`             | `{"name":"alice"}`              | register (idempotent)           |
| DELETE | `/agents/alice`       |                                 | unregister                      |
| POST   | `/send`               | `{"from","to?","topic?","content"}` | relay a message             |
| GET    | `/inbox/alice`        | `?topic=&after=`                | read-and-drain alice's mailbox  |
| GET    | `/log`                | `?topic=&after=`                | global read-only log            |
| GET    | `/stream?name=alice`  |                                 | SSE: live messages for alice    |

Semantics:

- `to` omitted = broadcast to every mailbox except the sender's.
- A direct send to an unregistered agent is an error (`400`).
- `read()` / `inbox` **drains** — messages are consumed once. `log` never
  drains.
- `id` is a monotonic counter usable as the `after=` cursor.
- `register` is idempotent (returns the existing mailbox), so a restarting
  agent keeps its queue.

## Why not a DB / queue / redis

Because a relay doesn't need one. Everything lives in process memory: pending
mailboxes for delivery, a flat log for "what was said", SSE subscribers for
live tails. If you need durable delivery across host restarts, swap `Host` for
a storage-backed store behind the same HTTP API — the wire protocol is the
contract.

## Development

```bash
npm install
npm test
npm run build
```