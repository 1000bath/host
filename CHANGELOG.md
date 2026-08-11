# Changelog

## [Unreleased]

- Added SQLite persistence (`PersistentHost`, `SqliteStore`) via `node:sqlite` — agents, message log, and undelivered mailbox queues survive restarts (`host serve --db host.db`).
- Added central message relay `Host` with register, send, broadcast, read-and-drain inbox, global log, and SSE subscription.
- Added HTTP/SSE server (`startHostServer`, zero deps, `node:http`).
- Added `HostClient` for programmatic agent access over the wire.
- Added `host` CLI (serve / register / unregister / agents / send / broadcast / inbox / log / watch).