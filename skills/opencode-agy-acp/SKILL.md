---
name: opencode-agy-acp
description: Driving the `agy` and `agy_job` tools from `opencode-agy-acp`, which run Google Antigravity CLI (`agy acp`) over ACP with native OpenCode permission bridging and background execution. Load this whenever the user explicitly asks to use `agy` / Antigravity, runs `/agy`, wants to run `agy` in the background, pick a Gemini 4 or Claude 5.5 model tier, resume a timed-out `agy` session, or handle an `AGY_ERROR [CODE]` result.
---

# opencode-agy-acp

`agy` delegates work to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP). Unlike headless print mode, `agy acp` bridges every tool permission request (`read`, `edit`, `bash`, `webfetch`) directly through OpenCode's native `ctx.permission.assert(...)` rules and interactive prompts, streams live step progress into the OpenCode TUI, and supports concurrent foreground and background runs with explicit `session_id` continuation.

**Only invoke `agy` when the user explicitly requests using `agy` / Antigravity (or runs `/agy`). Do not call it proactively.**

Nothing `agy` produces is verified. Reading diffs, checking files, and running tests yourself is your job, not `agy`'s.

## Writing the brief

`agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Write a self-contained brief, not a vague wish:

- **Give paths, not huge file dumps:** Provide exact workspace-relative or absolute paths `agy` can read directly.
- **State edit vs. read-only intent:** Explicitly tell `agy` whether it should only analyze/review or is allowed to edit files and run commands.
- **Define the finish line:** Specify constraints (language, style, what not to touch) and what to include in its final reply (changed files, diff/summary, verification commands run, remaining issues).
- **A leading `/` is an `agy` command, not plain text:** `agy acp` parses a prompt starting with `/` (even after leading whitespace) as one of its own slash commands (`/goal` and `/compact`). Use `/goal <brief>` on purpose when you want `agy` to push through a multi-step checklist without stopping early (pair with a generous `timeout_ms`). Do **not** start prompts with OpenCode role or workflow commands (`/worker`, `/architect`, `/reviewer`, `/review`) — `agy` does not recognize them; name the role in words and point at any relevant `SKILL.md` file path instead.
- **Let `agy` background long commands normally:** `agy`'s shell tool auto-backgrounds commands that run longer than 10s, ending `agy`'s initial turn while the command continues and waking `agy` back up reactively when it finishes. `opencode-agy-acp` automatically holds the ACP session open across in-progress background commands/timers and `agy`'s reactive wakeup turns until `agy` finishes. Do **not** tell `agy` to "wait in the foreground" or "not leave commands in the background" — that only forces it to busy-poll `manage_task` and waste turns.
- **Wait for subagents:** If delegating complex work, ask `agy` to wait for any internal subagents before finishing so its final response contains the complete result.

## Background execution (`background`, `wait_ms`, and `agy_job`)

You can run `agy` in the background so the OpenCode session remains free to continue other work or talk with the user:

- **Launch immediately in the background (`background: true`):** `agy` initializes the ACP session (`session/new` or `session/load`) so fast-fail errors surface right away, then detaches the prompt turn and returns `job_id` + `agy_session_id` immediately.
- **Wait briefly, then auto-background (`wait_ms`):** Pass `wait_ms` (e.g. `10000`) to wait up to that threshold in the foreground; if `agy` completes in time, you get the final answer directly, otherwise it detaches to the background automatically. (Users can also press `b` in `/agy-trace` to move a blocking foreground `agy` call into the background mid-flight.)
- **Reactive wakeup (no polling):** When a background `agy` run finishes or errors, the plugin automatically delivers its result into the OpenCode session via `ctx.session.synthetic` (`resume: true`) and wakes you back up. **Never busy-poll `agy_job` in a loop** — either continue independent work or end your turn and let the completion notification resume you.
- **Do not nudge interim status replies:** When `agy` backgrounds a long command or waits on an internal subagent, its text stream may contain an interim status line (e.g., `"Running make check…"`, `"Waiting for subagents…"`) before the reactive wakeup turn appends the final report. If any reply or status check names work still running, treat it as progress rather than a stopped worker — check `agy_job({ action: "list" })` if unsure and wait for the wakeup report instead of sending duplicate `"continue"` prompts into the same `session_id`.
- **Managing background runs (`agy_job`):**
  - `agy_job({ action: "list" })` — list running and recent background `agy` jobs in this session.
  - `agy_job({ action: "status", job_id })` — inspect live step progress or retrieve a completed job's result without blocking.
  - `agy_job({ action: "wait", job_id, timeout_ms })` — explicitly block until a specific background job (or the next active job if `job_id` is omitted) settles and return its output directly.
  - `agy_job({ action: "cancel", job_id })` — send graceful ACP `session/cancel` to stop a running background job (or pass `job_id: "all"` to cancel all active jobs in this session). Users can also press `x` in `/agy-trace` to cancel any running trajectory.

## Model selection (`gemini-4` preferred; `claude-5-5` secondary)

Only use models from the **`gemini-4`** and **`claude-5-5`** families. **Prefer Gemini 4 models by default** (Neon outperforms Opus 5.5 on most published benchmarks); use Claude 5.5 mainly when a cross-model second opinion or Claude-specific preference is requested.

- **Gemini 4 (preferred):** `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}`, `gemini-4-argon-{low|medium|high}`
- **Claude 5.5 (secondary):** `claude-{opus|sonnet}-5-5-{low|medium|high}`

| Model family | Effort levels | Best used for |
| --- | --- | --- |
| `gemini-4-hydrogen-*` | `low`, `medium`, `high`, `xhigh` | Fast everyday coding & agentic workhorse: bulk implementation, scaffolding, test generation, and subagent execution (Sonnet-class speed/efficiency). |
| `gemini-4-neon-*` | `low`, `medium`, `high`, `xhigh` | Default flagship coding & agentic model (Opus-class, outperforming Opus 5.5 on most benchmarks): complex multi-step engineering, deep debugging, and high-judgment orchestration. |
| `gemini-4-argon-*` | `low`, `medium`, `high` | Fable-class frontier reasoning model: hardest architectural judgment, long-horizon projects, and deepest problem-solving. |
| `claude-sonnet-5-5-*` | `low`, `medium`, `high` | Secondary cross-model option for careful code reviews and clean edits. |
| `claude-opus-5-5-*` | `low`, `medium`, `high` | Secondary cross-model option for second-opinion reviews on risky diffs or gnarly refactors. |

## Session continuity & timeouts

- **Fresh by default:** Omit `session_id` to start a fresh `agy` session. There is no implicit warm reuse, and multiple `agy` calls can run concurrently.
- **Continuing a specific session:** Pass `session_id` (from a prior result's `[agy_session_id: ...]` footer or `metadata.agySessionId`) to explicitly continue that `agy` session via ACP `session/load`. If `session/load` fails, the tool returns `AGY_ERROR [SESSION_LOAD_FAILED]` instead of silently starting a new session.
- **Timeouts:** Default `timeout_ms` is 15 minutes (`900000`), max 4 hours (`14400000`). On `AGY_ERROR [TIMEOUT]`, do **not** restart from scratch — pass `session_id` from `metadata.agySessionId` and `timeout_ms` from `metadata.suggestedNextTimeoutMs` with a continuation prompt (e.g., `"Continue from where you left off and finish the task."`).

## Handling `AGY_ERROR [CODE]`

| Code | Next move |
| --- | --- |
| `TIMEOUT` | Resume with `session_id` (`metadata.agySessionId`) and `timeout_ms` (`metadata.suggestedNextTimeoutMs`). |
| `SESSION_LOAD_FAILED` | Requested `session_id` could not be loaded. Verify the ID or omit `session_id` to start a fresh session. |
| `AUTH_REQUIRED` | `agy` is not signed in. Stop and ask the user to run `agy` interactively to log in. Do not retry in a loop. |
| `QUOTA_EXHAUSTED` | Rate limit or quota hit. Report it to the user and wait; do not retry in a loop. |
| `MODEL_NOT_FOUND` | Selected model is unavailable for this account. Switch to another `gemini-4-*` or `claude-*-5-5-*` model (or omit `model` to use `agy`'s default). |
| `AGY_NOT_FOUND` | `agy` binary is not on `PATH` (or `AGY_BIN` is invalid). Report to the user; do not retry. |
| `INVALID_ARGUMENT` | Fix the tool arguments (e.g., non-empty `prompt`) before retrying. |
| `AGY_FAILED` | Inspect the error details and stderr tail before deciding whether to retry once or handle directly. |

## After `agy` returns

Inspect the changed files or diff, run tests/typechecks yourself, and confirm the work actually landed as requested. Treat `agy`'s summary as a claim until verified. If something is wrong, fix it directly or send one targeted follow-up by explicitly passing `session_id` from the prior result.
