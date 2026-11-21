# opencode-agy-acp

Zero-dependency OpenCode 2.0 plugin that drives the official Google Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP) and bridges `agy` permission requests into OpenCode's native `ctx.permission.assert(...)` rules.

## Why ACP instead of `agy -p` or OAuth plugins?

- **No OAuth token spoofing:** Authentication stays inside the official `agy` CLI (`~/.gemini/antigravity-cli/`).
- **Native OpenCode permissions:** ACP `session/request_permission` requests from `agy` are mapped to OpenCode's `read` / `edit` / `bash` / `webfetch` / `agy` actions and evaluated through `ctx.permission.assert(...)`, using your existing `opencode.json` rules and interactive prompts.
- **Explicit sessions & concurrent runs:** Spawns an isolated `agy acp` subprocess per tool call so multiple `agy` agents can run concurrently without cross-talk, omits implicit session reuse (omit `session_id` for a fresh session; pass `session_id` to explicitly continue via ACP `session/load`), and forwards `AbortSignal` to ACP `session/cancel`.
- **Live TUI step streaming:** Exports a `./tui` OpenCode 2.0 TUI plugin that renders a live `agy` activity feed in `session.composer.top` while running and a scrollable full trace in `session.panel` (click the feed or run `Toggle agy trace panel` from the command palette).
- **Scrubbed environment:** Only passes a minimal allowlist (`PATH`, `HOME`, `XDG_*`, `AGY_*`, locale/proxy/TLS vars) to `agy acp` so unrelated provider API keys are never leaked.

## Installation

1. Ensure `agy` is installed and signed in (`agy` interactive login).
2. Add this repo path to `"plugins"` in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    "/home/minttea/codebases/dayvidpham/opencode-agy-acp"
  ]
}
```

3. Restart OpenCode.

Optional environment variables:
- `AGY_BIN`: override the `agy` binary path (defaults to `agy` on `PATH`).

## Tool Interface (`agy`)

| Parameter | Type | Description |
|---|---|---|
| `prompt` | `string` (required) | Task or question to send to `agy`. |
| `session_id` | `string` | Explicitly continue a specific `agy` ACP session ID (via `session/load`). Omit to start a fresh `agy` session. |
| `cwd` | `string` | Working directory for the `agy` session (defaults to the current workspace). |
| `model` | `string` | Optional model ID to request via ACP `session/set_model`. |
| `timeout_ms` | `number` | Turn timeout in ms (default `900000` = 15 min; min `1000`, max `14400000`). |

## Testing

```bash
bun test
```
