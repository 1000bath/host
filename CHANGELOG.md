# Changelog

## [Unreleased]

- Added a job/status state machine (`open → claimed → done | failed`) with a shared work queue: `host job new|list|claim|done|fail`, HTTP `/jobs*` routes, client methods, and MCP tools `job_create/job_list/job_claim/job_done/job_fail`. Failed jobs return to open for retry; only the claimant can complete/fail.
- Added an MCP server (`host mcp`) exposing register/unregister/agents/send/broadcast/inbox/log as tools over stdio, so MCP-capable agents (Claude Code, opencode, codex) can use the host without shelling out.
- Added `--content-file` to the CLI — send message content from a file, verbatim, without shell quoting issues.
- Added SQLite persistence (`PersistentHost`, `SqliteStore`) via `node:sqlite` — agents, message log, and undelivered mailbox queues survive restarts (`host serve --db host.db`).
- Added central message relay `Host` with register, send, broadcast, read-and-drain inbox, global log, and SSE subscription.
- Added HTTP/SSE server (`startHostServer`, zero deps, `node:http`).
- Added `HostClient` for programmatic agent access over the wire.
- Added `host` CLI (serve / register / unregister / agents / send / broadcast / inbox / log / watch).