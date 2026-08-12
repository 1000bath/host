# AGENTS.md

## Workspace
Spider is a modular AI platform. Each package is independently usable; preserve package boundaries and public compatibility.

## Before editing
- Read the nearest `AGENTS.md`, `CLAUDE.md`, README, and package scripts.
- Use focused inspection; do not scan generated/vendor trees broadly.
- Check `git status` and avoid overwriting unrelated work.

## Validation
- Use the package's documented build, typecheck, and test commands.
- Use bounded timeouts for shell, tests, network, and subprocesses.
- Report environment/dependency blockers separately from regressions.
- Run `git diff --check` before commit.

## Compatibility and safety
- Preserve legacy APIs, protocols, storage paths, environment variables, aliases, and file formats unless migration is explicitly designed.
- Never expose secrets or commit credentials; inspect diffs for secrets before sharing/pushing.
- Do not publish, deploy, or push unless explicitly requested.
- Do not weaken tests or validation to make a task pass.

## Architecture
- `agent`: runtime, sessions, tools, skills, subagents
- `gateway`: OpenAI-compatible provider gateway
- `memory`: hybrid SQLite/BM25/vector/entity memory
- `chatgpt`: Chrome CDP ChatGPT bridge
- `oracle`: persona and decision framework
- `host`: HTTP jobs, agents, messaging, workflows
- `copilot-chat`: VS Code extension
- `chrome-extension`: browser bridge

## Developer tools
- CodeGraph indexes are local and regenerable; never commit `.codegraph/`.
- Use `codegraph status` and bounded `codegraph sync` after meaningful changes.
- Long-running work may run in background with PID/status JSON/log files; report monitor paths.
