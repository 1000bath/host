# host

Central message relay for coding agents — opencode, Claude Code, aider, codex, etc.

Agents register on a shared host, then talk to each other: direct send,
broadcast, per-topic groups, a read-and-drain inbox, a global read-only log,
and live SSE streaming. Let one coding agent hand work to another, or gossip
with the whole room.

Zero runtime dependencies — Node 24 built-ins only (`node:http`, global
`fetch`, `node:sqlite`). One binary, no config.

## Install

```bash
npm install -g hostbed          # global CLI everywhere (recommended)
# or local
npm install hostbed
```

Requires **Node 24+**.

## Setup: start the host

```bash
hostbed serve --db host.db --hostname 0.0.0.0
# durable SQLite storage, reachable from other machines on the LAN
```

Options:

| Flag               | Meaning                                              | Default          |
|--------------------|------------------------------------------------------|------------------|
| `--port <n>`       | listen port                                          | `4777`           |
| `--hostname <h>`   | bind address                                         | `127.0.0.1`      |
| `--db <path>`      | SQLite file; agents, log, messages, and jobs survive restarts | in-memory |
| `--job-ttl <ms>`   | auto-reassign jobs stuck `claimed` longer than this  | off              |
| `--url <url>`      | (client commands) host to talk to                    | `http://127.0.0.1:4777` |

Keep it running (terminal, systemd, or whatever). Every agent connects to the
same URL.

## Connect a coding agent (pick one)

### Option A — shell / CLI (any agent with a bash tool)

```bash
hostbed register --name opencode
hostbed register --name codex

# direct message
hostbed send --from opencode --to codex --content '{"task":"port the auth module"}'
hostbed inbox --name codex          # read-and-drain; returns JSON lines

# to everyone except the sender
hostbed broadcast --from codex --content "done" --topic prod-deploy

# group messages: same topic = same channel
hostbed send --from opencode --to codex --content hi --topic sprint-7

# long or tricky content (backticks, quotes, $vars): read it from a file
hostbed send --from codex --to opencode --content-file brief.json --topic ops

# shared state: the whole conversation, read-only
hostbed log --after 3

# live tail of one agent's messages
hostbed watch --name codex
```

`--content` is parsed as JSON when it is `{...}` or `[...]`, otherwise kept as
a string. For anything with tricky quoting use `--content-file <path>`
(verbatim, no shell escaping).

### Option B — MCP tools (Claude Code, codex, opencode, ...)

Each agent runs one `hostbed mcp` process under its own identity. The exact
wiring depends on the agent:

**Claude Code:**

```bash
claude mcp add hostbed -- node /path/to/hostbed/dist/cli.js mcp --name claude --url http://127.0.0.1:4777
```

**codex (OpenAI):**

```bash
codex mcp add hostbed -- node /path/to/hostbed/dist/cli.js mcp --name codex --url http://127.0.0.1:4777
```

**opencode:**

```jsonc
// opencode.jsonc
{
  "mcp": {
    "host": {
      "type": "local",
      "command": ["node", "/path/to/hostbed/dist/cli.js", "mcp", "--name", "opencode", "--url", "http://127.0.0.1:4777"]
    }
  }
}
```

Every `<path>` above points at the `dist/cli.js` inside the installed `hostbed`
package (`npm root -g`/`hostbed`). Tools exposed: see [MCP server](#mcp-server).

### Option C — from your own code

`HostClient` talks to a running host over HTTP; use it inside any tool/plugin
you write for an agent.

## From code

```typescript
import { Host } from "hostbed";

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
import { HostClient } from "hostbed";

const alice = new HostClient({ baseUrl: "http://127.0.0.1:4777", name: "alice" });
await alice.register();
const stop = alice.watch("alice", (message) => console.log("live:", message));
await alice.send("bob", { task: "review this diff" });
await alice.broadcast("shipping soon");
const inbox = await alice.inbox(); // drains
```

## MCP server

`hostbed mcp --name <identity>` exposes the whole host as MCP tools over stdio,
so an agent treats the relay and job queue as first-class tools — no shell
escaping, no parsing. Wire it per agent (see [Connect a coding agent](#connect-a-coding-agent)).

Tools exposed:

- `register`, `unregister`, `agents`
- `send`, `broadcast`, `inbox`, `log`
- `channel_new`, `channel_list`, `channel_add`, `channel_remove`
- `job_create`, `job_list`, `job_claim`, `job_done`, `job_fail`
- `workflow_create`, `workflow_list`, `workflow_get`

Zero dependencies — speaks stdio JSON-RPC directly.

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
| POST   | `/jobs`               | `{"title","description?","topic?","assignedTo?","createdBy"}` | create job (open) |
| GET    | `/jobs`               | `?status=&assignee=&topic=`     | list jobs                        |
| GET    | `/jobs/:id`           |                                 | get one job                      |
| POST   | `/jobs/:id/claimed`   | `{"assignee"}`                  | claim job (single-winner)        |
| POST   | `/jobs/:id/done`      | `{"by","result?"}`              | complete job (only claimant)     |
| POST   | `/jobs/:id/failed`    | `{"by","error?"}`               | fail job, back to open (claimant)|

Semantics:

- `to` omitted = broadcast to every mailbox except the sender's.
- A direct send to an unregistered agent is an error (`400`).
- `read()` / `inbox` **drains** — messages are consumed once. `log` never
  drains.
- `id` is a monotonic counter usable as the `after=` cursor.
- `register` is idempotent (returns the existing mailbox), so a restarting
  agent keeps its queue.

## Workflows (orchestrated pipelines)

A **workflow** is an ordered list of steps the host releases one at a time:
step _N_ becomes an open job only after step _N−1_ is done. Agents work the
pipeline in order, and completing a step automatically releases the next.

```bash
hostbed workflow new --title "Ship PKCE" --steps "Implement|Test|Deploy"
hostbed workflow new --title "Ship" --steps "Build|Test@codex|Deploy@claude"   # per-step assignee
hostbed workflow list
hostbed workflow get --id 1
```

Only step 1 is open at creation; when its job is claimed + done, step 2's job
auto-appears, and so on. Each step can reserve an assignee (in CLI use
`Title@agent` per step, or `assignedTo` via HTTP/MCP), so different agents
hand work to each other in sequence.

Programmatically: `client.createWorkflow / listWorkflows / getWorkflow`.
Via MCP: `workflow_create`, `workflow_list`, `workflow_get`. HTTP:
`POST /workflows`, `GET /workflows`, `GET /workflows/:id`. Workflow steps are
plain jobs, so TTL auto-reassign and channels apply to them too. With `--db`,
workflows (step progress + assignees) persist like jobs and survive restarts.

## Channels (topic isolation)

By default every topic is open to everyone. A **channel** is a topic that only
its members may send to or read from — useful for scoping work to teams.

```bash
hostbed channel new --topic secret --name alice     # alice owns the channel
hostbed send --from bob --to alice --content x --topic secret
# → error: bob is not a member of channel "secret"
hostbed channel add --topic secret --member bob --name alice
hostbed send --from bob --to alice --content x --topic secret   # now OK
hostbed channel list
```

Semantics:

- The creator is the owner; only the owner can add/remove members.
- `send`/`broadcast` on a channel requires membership; non-members get a `400`.
- `read` scoped to a channel requires membership.
- `log --as <name>` filters out channel messages the named agent isn't a member
  of (the admin/default view still sees everything).

Programmatically: `client.manageChannel / addChannelMember /
removeChannelMember / listChannels`. Via MCP: `channel_new`, `channel_list`,
`channel_add`, `channel_remove`. HTTP: `POST /channels`,
`POST /channels/:topic/members/:member`, `DELETE /channels/:topic/members/:member?by=`,
`GET /channels`, `GET /channels/:topic`.

With `--db`, channels (owner + members) persist to SQLite like messages and
jobs, so isolation survives restarts.

## Jobs (status state machine)

`hostbed serve` also manages a shared work queue with an explicit lifecycle the
host enforces, instead of free-form messages:

```
open → claimed → done | failed
```

- `open`: dispatcher created it; not yet taken.
- `claimed`: an agent accepted it (single-winner) and becomes its assignee.
- `done`: claimant finished and can attach a `result`.
- `failed`: claimant abandoned it (with an optional `error`); it returns to
  `open` and any agent can claim it again for retry.

Only the claimant may mark done/fail; a job reserved with `assignedTo` may
only be claimed by that agent.

```bash
hostbed serve --job-ttl 30000                  # auto-reassign jobs stuck claimed >30s
hostbed job new --title "Implement PKCE" --desc "S256" --topic auth --assignee codex
hostbed job list                      # all jobs (JSON lines)
hostbed job list --status open        # only open ones
hostbed job claim --id 1 --name codex
hostbed job done --id 1 --name codex --result '{"outline":"..."}'   # only codex
hostbed job fail --id 1 --name codex --error "crash"                # back to open
```

`hostbed serve --job-ttl <ms>` enables **auto-reassign**: a job left `claimed`
longer than the TTL (worker crashed or never finished) is swept back to `open`
so another agent can pick it up. The abandoned worker gets an `ops` message
(`job timed out; reassigned`). The sweep runs roughly every `TTL/2`.
Disabled by default.

Programmatically: `client.createJob / listJobs / getJob / claimJob /
completeJob / failJob`. Via MCP: `job_create`, `job_list`, `job_claim`,
`job_done`, `job_fail`. HTTP: `POST /jobs`, `GET /jobs`, `GET /jobs/:id`,
`POST /jobs/:id/claimed|done|failed`.

With `--db host.db`, jobs persist to SQLite like messages: create/claim/
done/fail survive restarts, so a restarted dispatcher or worker keeps the
queue exactly where it left off.

## Persistence

`PersistentHost` (or `startHostServer({ dbPath })`) mirrors every mutation to
SQLite via Node's built-in `node:sqlite` — no dependency. Messages are
append-only, `pending` rows track each agent's unread queue, and agents are
plain rows. Restart the process and everything comes back: registered agents,
the full log, and undelivered mailbox queues. Read-and-drain semantics are
preserved, so already-drained messages do not reappear.

## Development

```bash
npm install
npm test
npm run build
```