# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

CC-Web is a lightweight Node.js web interface for controlling Codex and Codex CLI agents remotely through a browser. It spawns CLI processes in detached mode with file-based I/O, enabling background task execution, process recovery after server restart, and real-time streaming via WebSocket.

Only runtime dependency: `ws` (WebSocket library). Frontend is vanilla JavaScript (no framework, no bundler).

## Commands

```bash
npm install          # Install dependencies
npm start            # Start server (local dev: port 8001, binds 0.0.0.0)
npm run regression   # Run end-to-end regression tests (uses mock CLIs in temp dirs)
```

There is no lint or type-check step. No build step — static files in `public/` are served directly.

The regression suite (`scripts/regression.js`) spawns a real server instance against mock CLIs (`scripts/mock-Codex.js`, `scripts/mock-codex.js`) in isolated temp directories. It validates session lifecycle, message flow, attachments, and model config via WebSocket.

## Architecture

```
Browser ──WebSocket──> server.js ──spawn──> Codex/codex CLI (detached)
                           │
                     File-based I/O
                   sessions/{id}-run/
                   (input.txt, output.jsonl, error.log, pid)
```

### Backend (`server.js` ~2800 lines)

Single-file server handling HTTP, WebSocket, process management, and session storage. Key subsystems:

- **Process management**: CLI processes run detached with `proc.unref()`. Communication uses file I/O (not pipes) — user input written to `input.txt`, CLI output read from `output.jsonl` via `FileTailer` class. PID files enable process recovery on restart.
- **Session storage**: JSON files in `sessions/` directory. Each session tracks agent type (Codex/codex), messages, model, cwd, and permission mode. Codex sessions use `--resume {sessionId}`, Codex uses thread IDs.
- **Config files**: `config/auth.json` (password), `config/model.json` (API templates), `config/codex.json` (profiles), `config/notify.json` (notification channels).
- **Notifications**: 5 providers (PushPlus, Telegram, Server酱, Feishu, Qmsg) — fires on task completion.
- **Attachments**: Images stored in `sessions/_attachments/` with 7-day TTL, 10MB max, 4 per message.

### Agent Runtime (`lib/agent-runtime.js`)

Pluggable abstraction for building spawn arguments and parsing CLI output events. Exports `createAgentRuntime()` which receives server dependencies via injection. Two agent adapters:

- `buildClaudeSpawnSpec()` / `processClaudeEvent()` — handles `stream-json` format, permission modes (yolo/plan/default), model selection, custom API template injection into `~/.Codex/settings.json`.
- `buildCodexSpawnSpec()` / `processCodexEvent()` — handles Codex event stream, runtime profile switching, image attachments.

### Codex Rollout Parser (`lib/codex-rollouts.js`)

Imports Codex CLI history from `~/.codex/sessions/` JSONL files into CC-Web session format.

### Frontend (`public/app.js` ~4200 lines)

Single-file vanilla JS SPA. Communicates entirely via WebSocket. Key patterns:

- **Message types**: `auth`, `message`, `text_delta`, `tool_start`, `tool_end`, `cost`, `session_list`, etc.
- **Session cache**: Up to 4 sessions cached in memory (1.5MB weight limit) with LRU eviction for fast switching.
- **Dual-agent UI**: Sidebar groups sessions by agent (Codex/Codex), each with independent settings panels.
- **Slash commands**: `/clear`, `/model`, `/mode`, `/cost`, `/compact`, `/help` — handled client-side.
- **Theme system**: 3 themes stored in localStorage (Washi Warm, CoolVibe Light, Editorial Sand).
- **Rendering**: marked.js for Markdown, highlight.js for syntax highlighting.

## Key Design Patterns

- **File-based I/O over pipes**: Enables clean process detachment — the Node.js server can restart while CLI processes continue running. `FileTailer` watches output files and streams lines to WebSocket clients.
- **Dependency injection**: `agent-runtime.js` receives all server dependencies (config loaders, WebSocket helpers, session persistence) through a `deps` object, keeping it testable without importing server internals.
- **Atomic config writes**: Custom API templates are written to `~/.Codex/settings.json` using write-to-temp + rename to avoid corruption from concurrent access.
- **Environment variable hierarchy**: `.env` file values are only set if the env var is not already present in `process.env` (existing env vars take precedence).

## Storage Layout

```
config/          # Runtime configuration (auth, model, codex profiles, notifications)
sessions/        # Session JSON files + per-run I/O directories + attachments
logs/            # JSONL process lifecycle log (auto-rotates at 2MB)
public/          # Static frontend files (served as-is)
lib/             # Shared modules (agent-runtime, codex-rollouts)
scripts/         # Regression tests and mock CLIs
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8001` | Server listen port (local dev uses 8001) |
| `HOST` | `0.0.0.0` | Server bind address (listens on all interfaces) |
| `CLAUDE_PATH` | `Codex` | Path to Codex CLI binary |
| `CODEX_PATH` | `codex` | Path to Codex CLI binary |
| `CC_WEB_PASSWORD` | auto-generated | Initial login password |
| `CC_WEB_CONFIG_DIR` | `./config` | Config directory path |
| `CC_WEB_SESSIONS_DIR` | `./sessions` | Sessions directory path |
| `CC_WEB_LOGS_DIR` | `./logs` | Logs directory path |
