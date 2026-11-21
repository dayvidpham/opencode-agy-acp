# opencode-agy-acp

![OpenCode agy-trace panel](docs/agy-trace-panel.jpg)

Zero-dependency OpenCode 2.x plugin (`dayvidpham.opencode-agy-acp`) that drives the official Google Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP), bridges permission requests into OpenCode's native `ctx.permission.assert(...)` rules, and streams live step progress into the OpenCode TUI.

## Installation

1. Ensure `agy` is installed and signed in (`agy` interactive login).
2. Clone this repo and add its path to `"plugins"` in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "/path/to/opencode-agy-acp"
  ]
}
```

3. Restart OpenCode (and the background service if already running).

Optional environment variables:
- `AGY_BIN`: override the `agy` binary path (defaults to `agy` on `PATH`).

## Slash Commands & TUI Trace Panel

- **`/agy <task>`** — delegates a task to the `agy` tool with structured prompt guidance.
- **`/agy-trace`** (or `Ctrl+P` → **Toggle agy trace panel**) — opens or closes the scrollable `agy-trace` panel (`session.panel`) showing all running and completed `agy` runs in the current session. Running trajectories expand automatically; completed runs start collapsed and can be toggled individually or all at once.
- **Live footer indicator (`prompt.footer.status`)** — appears inline in the prompt footer while one or more `agy` agents are running (e.g. `◈ 3 agy (180 steps)`) without taking extra vertical space. Clicking it opens the full trace panel.

### Trace Panel Keyboard Shortcuts

When the `agy-trace` panel is focused (or in fullscreen):

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | Select next / previous trajectory |
| `Enter` / `Space` (or click header) | Expand / collapse selected trajectory |
| `e` / `c` | Expand all / collapse all trajectories |
| `f` | Toggle fullscreen / split |
| `q` / `Esc` | Close panel |
| `j` / `↓`, `k` / `↑` | Scroll down / up |
| `PgDn` / `Ctrl+D`, `PgUp` / `Ctrl+U` | Page down / up |
| `g` / `Shift+G` | Jump to top / bottom |

## Tool Interface (`agy`)

| Parameter | Type | Description |
| --- | --- | --- |
| `prompt` | `string` (required) | Task or question to send to `agy`. Start with a normal word (never a leading `/`, which triggers `agy` slash-command expansion). |
| `session_id` | `string` | Explicitly continue a specific `agy` ACP session ID via `session/load`. Omit to always start a fresh `agy` session. |
| `cwd` | `string` | Working directory for the `agy` session (defaults to the current workspace). |
| `model` | `string` | Optional model ID to select via ACP `session/set_model` (e.g. `gemini-4-hydrogen-medium`, `gemini-4-neon-medium`, `gemini-4-argon-medium`, or `claude-sonnet-5-5-medium` / `claude-opus-5-5-medium`). |
| `timeout_ms` | `number` | Turn timeout in ms (default `900000` = 15 min; min `1000`, max `14400000`). |

Every response (success or error, once a session exists) appends `[agy_session_id: <id>]` to `content` and includes `metadata.agySessionId`, making explicit follow-ups and timeout recovery straightforward.

### Structured Errors (`AGY_ERROR [CODE]`)

`TIMEOUT`, `SESSION_LOAD_FAILED`, `AUTH_REQUIRED`, `QUOTA_EXHAUSTED`, `MODEL_NOT_FOUND`, `AGY_NOT_FOUND`, `INVALID_ARGUMENT`, `AGY_FAILED`.

## Prior Art & Why ACP

This plugin was inspired by [`chigarow/antigravity-for-opencode`](https://github.com/chigarow/antigravity-for-opencode), which pioneered delegating scoped tasks from OpenCode to the official `agy` CLI — keeping authentication inside `~/.gemini/antigravity-cli/` instead of handing Google OAuth tokens to unofficial third-party OAuth plugins — and set strong conventions around secret scrubbing, environment isolation, and `/agy` prompt hygiene.

`opencode-agy-acp` builds on that foundation by switching the transport from **one-shot headless `agy -p`** to **bidirectional `agy acp` (Agent Client Protocol)**:

| Capability | Headless `agy -p` (`antigravity-for-opencode`) | Bidirectional `agy acp` (`opencode-agy-acp`) |
| --- | --- | --- |
| **Permissions** | All-or-nothing: actions outside defaults are soft-denied unless `yolo: true` (`--dangerously-skip-permissions`) is enabled | Every ACP `session/request_permission` is bridged into OpenCode's native `ctx.permission.assert(...)` rules and interactive prompts — no `yolo` needed |
| **Live visibility** | Black-box wait until `agy -p` exits | Streams typed ACP `tool_call`, `plan`, thought, and text events live into OpenCode's TUI (`prompt.footer.status` + `/agy-trace` panel), including for concurrent Code Mode (`execute`) calls |
| **Sessions & concurrency** | Parses `--log-file` to recover `conversationId`; supports implicit `--continue` | Explicit per-call ACP sessions (`session/new` / `session/load`, failing loudly with `SESSION_LOAD_FAILED`), concurrent isolated subprocesses, and structured token `usage` |
| **Cancellation & reload** | Terminates the subprocess | Sends graceful ACP `session/cancel` on `AbortSignal`, closes each subprocess in `finally`, and leaves in-flight turns untouched on plugin hot-reload |
| **Model selection** | Hardcoded `tier` enum that requires updates when upstream models change | Passes model IDs directly via ACP `session/set_model` |
| **Environment & packaging** | Dual OpenCode v1/v2 compat with `dist/` build step | OpenCode 2.x-native, zero runtime deps, no build step (direct TS/TSX hot-reload), and scrubbed child env (`PATH`, `HOME`, `XDG_*`, `AGY_*`, `NIX_*`, proxy/TLS vars only) |

If you need **OpenCode 1.x compatibility** or strict host-level `AGY_WORKSPACE_ROOT` path containment on `--add-dir`, [`chigarow/antigravity-for-opencode`](https://github.com/chigarow/antigravity-for-opencode) remains a great option. If you're on **OpenCode 2.x** and want native permission bridging, live step streaming, and structured ACP lifecycle control, `opencode-agy-acp` is built for that.

## Project Layout

- `src/index.ts` — OpenCode server plugin (`agy` tool, `/agy` command, `opencode-agy-acp` skill registration)
- `src/tui.tsx` — OpenCode `./tui` plugin (`prompt.footer.status` live indicator, `session.panel` trace viewer, `/agy-trace`)
- `src/acp.ts` — Zero-dependency bidirectional NDJSON JSON-RPC 2.0 ACP client + env scrubbing
- `src/permissions.ts` — ACP `session/request_permission` → OpenCode `ctx.permission.assert(...)` bridge
- `src/trace.ts` — Atomic per-session trace store shared between server and TUI
- `src/errors.ts` — Structured error classification and secret scrubbing
- `commands/agy.md` & `skills/opencode-agy-acp/SKILL.md` — Bundled `/agy` command prompt and usage skill
- `test/acp.test.ts` — Offline mock-ACP unit test suite

## Testing

```bash
bun test
```
