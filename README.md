# opencode-agy-acp

Zero-dependency OpenCode 2.0 plugin that drives the official Google Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP) and bridges `agy` permission requests into OpenCode's native `ctx.permission.assert(...)` rules.

## Why ACP instead of `agy -p` or OAuth plugins?

- **No OAuth token spoofing:** Authentication stays inside the official `agy` CLI (`~/.gemini/antigravity-cli/`).
- **Native OpenCode permissions:** ACP `session/request_permission` requests from `agy` are mapped to OpenCode's `read` / `edit` / `bash` / `webfetch` / `agy` actions and evaluated through `ctx.permission.assert(...)`, using your existing `opencode.json` rules and interactive prompts.
- **Warm sessions & cancellation:** Keeps a single `agy acp` subprocess alive per OpenCode instance, reuses `agy` sessions per OpenCode `sessionID`, streams live progress, and forwards `AbortSignal` to ACP `session/cancel`.
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
| `session_id` | `string` | Resume a specific `agy` ACP session ID. |
| `new_session` | `boolean` | Start a fresh `agy` session instead of reusing the one mapped to the current OpenCode session. |
| `cwd` | `string` | Working directory for a new `agy` session (defaults to the current workspace). |
| `model` | `string` | Optional model ID to request via ACP `session/set_model`. |
| `timeout_ms` | `number` | Turn timeout in ms (default `900000` = 15 min; min `1000`, max `14400000`). |

## Testing

```bash
bun test
```
