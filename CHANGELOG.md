# Changelog

## [Unreleased]

- Added workflow orchestration: ordered pipelines that release one step at a time (`open→claimed→done`), auto-opening the next step when the previous completes. Available via `host workflow new|list|get` CLI, `/workflows` HTTP, client methods, and MCP tools `workflow_create/workflow_list/workflow_get`.
- Persisted channels (owner + members) to SQLite and exposed them via MCP tools (`channel_new/channel_list/channel_add/channel_remove`) alongside the existing CLI/HTTP/client surfaces.
- Added channel isolation: a managed topic is private to its members. Owners restrict send/broadcast/read to members, and `log --as <name>` hides channels the viewer can't access (`host channel new|add|remove|list`).
- Rewrote README with step-by-step setup: install, starting the host, per-agent connect recipes (CLI, MCP for Claude Code/codex/opencode), the HTTP API table, and the job workflow.
- Added auto-reassign (`host serve --job-ttl <ms>`): jobs stuck `claimed` past the TTL are swept back to `open` for retry, and the abandoned worker is notified.
- Persisted jobs to SQLite (`PersistentJobRegistry`) — the work queue now survives restarts alongside messages when running with `--db`.
- Added a job/status state machine (`open → claimed → done | failed`) with a shared work queue: `host job new|list|claim|done|fail`, HTTP `/jobs*` routes, client methods, and MCP tools `job_create/job_list/job_claim/job_done/job_fail`. Failed jobs return to open for retry; only the claimant can complete/fail.
- Added an MCP server (`host mcp`) exposing register/unregister/agents/send/broadcast/inbox/log as tools over stdio, so MCP-capable agents (Claude Code, opencode, codex) can use the host without shelling out.
- Added `--content-file` to the CLI — send message content from a file, verbatim, without shell quoting issues.
- Added SQLite persistence (`PersistentHost`, `SqliteStore`) via `node:sqlite` — agents, message log, and undelivered mailbox queues survive restarts (`host serve --db host.db`).
- Added central message relay `Host` with register, send, broadcast, read-and-drain inbox, global log, and SSE subscription.
- Added HTTP/SSE server (`startHostServer`, zero deps, `node:http`).
- Added `HostClient` for programmatic agent access over the wire.
- Added `host` CLI (serve / register / unregister / agents / send / broadcast / inbox / log / watch).