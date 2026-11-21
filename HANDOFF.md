# Handoff: `opencode-agy-acp` (OpenCode 2.0 Plugin for `agy acp`)

**Target Repository:** `/home/minttea/codebases/dayvidpham/opencode-agy-acp/`
**Status:** Initial zero-dependency TypeScript/Bun scaffold and offline unit test suite written; **no commands (`bun test`, `git init`, live `agy acp` handshake, or OpenCode load test) have been executed yet** because the originating session's terminal sandbox was unavailable (`connecting to sandbox server: read unix @->@: recvmsg: connection reset by peer`).

---

## 1. Context & Goal

The user wants to use their existing **Google Antigravity CLI (`agy`) OAuth subscription** from inside **OpenCode 2.0** without:
- Handing Google OAuth tokens to unofficial third-party OAuth plugins (`NoeFabris/opencode-antigravity-auth` was archived on 2026-08-28; active forks like `@cortexkit/opencode-antigravity-auth` and `andyvandaric/opencode-ag-auth` carry Google Terms of Service / account suspension risk and un-audited npm supply-chain risk).
- Relying on AWS/Kiro credentials (`KiroCrew` has no native `agy` backend).
- Falling back to `agy -p` headless print mode (`chigarow/antigravity-for-opencode`), which soft-denies un-allowlisted actions unless `--dangerously-skip-permissions` (`yolo: true`) is enabled.

**Chosen Architecture (Approach A):**
A standalone, zero-dependency **OpenCode 2.0** Bun/TypeScript plugin that:
1. Spawns the official local **`agy acp`** subprocess over `stdio` (newline-delimited JSON-RPC 2.0) using the user's already-authenticated local `~/.gemini/antigravity-cli/` OAuth session.
2. Registers an **`agy`** tool in OpenCode via `ctx.tool.transform((tools) => tools.add(...))`.
3. Bridges ACP `session/request_permission` server-initiated requests directly into OpenCode 2.0's **`ctx.permission.assert(...)`**, so the user's existing `~/.config/opencode/opencode.json` permission rules (`read`, `edit`, `bash`, `webfetch`, `agy`) and interactive TUI prompts govern every action `agy` attempts.
4. Streams live `session/update` progress via `toolCtx.progress(...)`, forwards `toolCtx.signal` (`AbortSignal`) to ACP `session/cancel`, reuses warm `agy` ACP sessions per OpenCode `sessionID`, and cleanly tears down the subprocess on plugin disposal.

---

## 2. Key Decisions (Confirmed)

1. **Standalone repository placement:** Lives at `/home/minttea/codebases/dayvidpham/opencode-agy-acp/` and is loaded via the `"plugins"` array in `~/.config/opencode/opencode.json` (matching the existing local plugin pattern used for `/home/minttea/codebases/teary0--opencode-claude-auth`). Not coupled to Pasture's Go codegen.
2. **Zero runtime npm dependencies:** Follows the same zero-import Bun convention as Pasture's OpenCode 2.0 lifecycle plugin (`/home/minttea/codebases/dayvidpham/aura-plugins/pasture/.opencode/plugins/pasture-lifecycle.ts`), so OpenCode can load `./src/index.ts` directly without a build step or `node_modules`.
3. **Environment scrubbing:** `buildScrubbedEnv()` passes only an explicit allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`, `TMP*`, `LC_*`, `XDG_*`, `AGY_*`, proxy, and TLS cert vars) so unrelated provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) never leak into `agy acp`.
4. **Serialized turn execution per plugin instance:** A promise queue serializes `agy` tool calls on the single `stdio` ACP subprocess so streamed `session/update` notifications and `session/request_permission` callbacks always correlate cleanly to the active OpenCode tool call.
5. **No modifications to `~/.config/opencode/opencode.json` yet:** Left untouched until unit tests and a live `agy acp` smoke test pass.

---

## 3. Verified Host & Reference Contracts

The plugin was written against the **actual installed OpenCode `2.0.31` TypeScript definitions** inspected on disk (not guessed):

| Contract | Verified Source Path | Exact Shape Used |
|---|---|---|
| Plugin export | `/home/minttea/codebases/teary0--opencode-claude-auth/node_modules/@opencode/plugin/dist/promise/plugin.d.ts` | `export default { id: string, setup: (ctx: Context) => Promise<Cleanup \| void> }` |
| Tool registration | `/home/minttea/codebases/teary0--opencode-claude-auth/node_modules/@opencode/plugin/dist/promise/tool.d.ts` | `await ctx.tool.transform((tools) => tools.add({ name, description, input, execute }))` -> `{ dispose() }` |
| Tool schema & context | `/home/minttea/codebases/teary0--opencode-claude-auth/node_modules/.pnpm/@opencode+schema@2.0.31/node_modules/@opencode/schema/dist/tool.d.ts` | `input`: plain JSON Schema; `context`: `{ sessionID, agent, messageID, id, signal, progress }`; returns `{ content, metadata }` |
| Permission bridge | `/home/minttea/codebases/teary0--opencode-claude-auth/node_modules/@opencode/plugin/dist/promise/permission.d.ts` & `../permission.d.ts` | `await ctx.permission.assert({ sessionID, agent?, action, resources, save?, metadata?, source?: { type: "tool", messageID, id } })` |
| Pasture Bun plugin reference | `/home/minttea/codebases/dayvidpham/aura-plugins/pasture/.opencode/plugins/pasture-lifecycle.ts` | Zero-import Bun plugin, pipe drain/cancel/reap hygiene, `dispose()` teardown |
| Pasture ACP wire reference | `/home/minttea/codebases/dayvidpham/aura-plugins/pasture/internal/acp/client.go` | NDJSON JSON-RPC 2.0 `session/update` & `ContentBlock` shapes (read-only Go observer) |
| User OpenCode config | `/home/minttea/.config/opencode/opencode.json` | Existing `"plugins"` array (lines 15-17) and `"permission"` rules (`read`, `edit`, `bash`, etc.) |

---

## 4. Key Files Created

All files are in `/home/minttea/codebases/dayvidpham/opencode-agy-acp/`:

- `package.json` — ESM package, `"main": "./src/index.ts"`, `"test": "bun test"`, zero dependencies.
- `src/acp.ts` — Bidirectional NDJSON JSON-RPC 2.0 ACP client (`AcpClient`, `buildScrubbedEnv`):
  - `ensureStarted()` (`initialize` handshake), `newSession(cwd)`, `loadSession(sessionId, cwd)`, `setModel(sessionId, modelId)`, `prompt(sessionId, text, { signal, timeoutMs })`, `cancelSession(sessionId)`, `close()`.
  - Async server-request handler for `session/request_permission` (non-blocking relative to `stdout` reader) and `-32601` Method Not Found reply for unknown server requests.
- `src/permissions.ts` — `mapAcpToolCallToOpenCodePermission`, `selectPermissionOptionId`, `handleAcpPermissionRequest`:
  - Maps ACP `toolCall` (`kind`, `title`, `rawInput`, `locations`) to OpenCode actions (`bash`, `edit`, `read`, `webfetch`, `agy`).
  - Translates `ctx.permission.assert` resolution/rejection/abort into ACP `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- `src/index.ts` — `createAgyAcpPlugin()`, `applySessionUpdate()`, and default export (`id: "opencode-agy-acp"`):
  - Registers `agy` tool (`prompt`, `session_id`, `new_session`, `cwd`, `model`, `timeout_ms`).
  - Maps OpenCode `sessionID` -> `agy` ACP `sessionId`; emits throttled `toolCtx.progress(...)`; returns resumable `agySessionId` on timeout.
- `test/acp.test.ts` — Offline `bun test` unit tests using an injected in-memory mock ACP process (`createMockAcpServer`).
- `README.md` & `.gitignore` — Setup instructions and standard ignores.

---

## 5. Open Items & Unverified Assumptions (Must Verify First)

Because no shell commands could run in the originating session, the receiving team **must** verify these items against the live local `agy` and `opencode` binaries:

1. **Run offline unit tests & typecheck:**
   - Run `bun test` in `/home/minttea/codebases/dayvidpham/opencode-agy-acp/`.
   - Verify TypeScript types (e.g., `bunx tsc --noEmit` or checking compatibility against the installed `@opencode/plugin` runtime).
2. **Verify live `agy acp` wire format:**
   - Confirm exact `initialize` request/response schema (`protocolVersion: 1` vs string/semver if `agy acp` expects a specific version or `clientCapabilities` fields).
   - Confirm exact `session/new` parameter keys (`cwd`, `mcpServers`) and response field (`sessionId` vs `session_id`).
   - Capture real `session/update` notifications emitted by `agy acp` to confirm whether text chunks arrive under `params.update.sessionUpdate === "agent_message_chunk"` with `params.update.content.text`, or a different field shape, and adjust `applySessionUpdate()` in `src/index.ts` if needed.
   - Capture a real `session/request_permission` payload from `agy acp` (e.g., triggering a file edit or bash command) to verify exact `toolCall` fields (`kind`, `title`, `rawInput`, `locations`) and `options[]` (`optionId`, `kind`) and confirm `src/permissions.ts` maps them cleanly.
   - Confirm whether `agy acp` supports `session/set_model`, `session/set_config_option`, and `session/load` (currently `session/set_model` and `session/load` gracefully fall back on error).
3. **Verify OpenCode 2.0 plugin loading & `ctx.permission.assert` behavior:**
   - Note in `permission.d.ts`: *"A plain rejection rejects with an error that ends the current step; rethrow it rather than returning it as tool output."* Currently `handleAcpPermissionRequest` catches all errors from `ctx.permission.assert` and returns `reject_once` to `agy` so `agy` can adapt. Verify in a live OpenCode session whether a user clicking "Reject" (plain rejection vs deny rule vs rejection with feedback) should abort the outer `agy` tool step or let `agy` continue after `reject_once`, and tune error classification accordingly.
   - Verify `opencode` loads `/home/minttea/codebases/dayvidpham/opencode-agy-acp` from `~/.config/opencode/opencode.json` `"plugins"` cleanly (and check if `ctx.command.transform` for a `/agy` slash command is desired).
4. **Git & Pasture tracking:**
   - Initialize git (`git init`) in `/home/minttea/codebases/dayvidpham/opencode-agy-acp/` (or create a remote repo if desired).
   - Note: No Pasture tracker tasks were created in `/home/minttea/.local/share/pasture/pasture.db` during the originating session due to the sandbox failure. If tracking this under Pasture `epoch`, run the probe / create the `REQUEST` and `HANDOFF` tasks via `rec` first.

---

## 6. Acceptance Criteria

- **AC1 (Unit tests):** Given the mock ACP suite in `test/acp.test.ts`, when `bun test` runs, then all tests pass with zero failures and no leaked timers/handles.
- **AC2 (Live handshake & turn):** Given an authenticated local `agy` CLI, when OpenCode invokes the `agy` tool with a prompt, then `agy acp` completes `initialize` -> `session/new` -> `session/prompt`, streams progress to OpenCode, and returns the final assistant text plus `metadata.agySessionId`.
- **AC3 (Permission bridging — allow):** Given an `agy` action matching an `"allow"` rule in `opencode.json` (e.g., `read`), when `agy acp` sends `session/request_permission`, then `ctx.permission.assert` resolves without prompting and `agy` receives `selected` (`allow_once`).
- **AC4 (Permission bridging — ask & deny):** Given an `agy` action matching an `"ask"` rule in `opencode.json` (e.g., `edit`), when `agy acp` sends `session/request_permission`, then OpenCode prompts the user interactively; approving sends `allow_once` and rejecting sends `reject_once` / `cancelled` cleanly without hanging `agy`.
- **AC5 (Warm session reuse & resume):** Given a second `agy` tool call in the same OpenCode session, when `new_session` is omitted/false, then the plugin reuses the existing `agySessionId`; when `new_session: true`, it opens a fresh `agy` session.
- **AC6 (Cancellation & cleanup):** Given an in-flight `agy` tool call, when aborted via OpenCode (`AbortSignal`) or when OpenCode exits (`dispose()`), then `session/cancel` is sent and no orphan `agy acp` process remains running.
- **AC7 (Env isolation):** Given `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` set in OpenCode's environment, when `agy acp` is spawned, then those variables are absent from the child process environment.

---

## 7. Quick-Start Prompt for the Receiving Agent Team

```text
Pick up `/home/minttea/codebases/dayvidpham/opencode-agy-acp/` by reading `HANDOFF.md` first.

Your goals:
1. Run `bun test` and fix any test or TypeScript issues.
2. Run a live smoke test against the local `agy acp` binary to capture its actual `initialize`, `session/new`, `session/update`, and `session/request_permission` JSON-RPC wire payloads, and align `src/acp.ts`, `src/permissions.ts`, and `src/index.ts` to any schema differences.
3. Verify loading the plugin in OpenCode 2.0 (via `~/.config/opencode/opencode.json`) and test AC1-AC7, including interactive `ctx.permission.assert` allow/deny behavior and clean subprocess teardown.
4. Add integration/regression tests for the observed real `agy acp` wire payloads (scrubbed of secrets/paths).
```
