---
name: opencode-agy-acp
description: Driving the `agy` tool from `opencode-agy-acp`, which runs Google Antigravity CLI (`agy acp`) over ACP with native OpenCode permission bridging. Load this whenever the user explicitly asks to use `agy` / Antigravity, runs `/agy`, wants to pick a Gemini 4 or Claude 5.5 model tier, needs to resume a timed-out `agy` session, or needs to handle an `AGY_ERROR [CODE]` result.
---

# opencode-agy-acp

`agy` delegates work to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol (ACP). Unlike headless print mode, `agy acp` keeps warm sessions per OpenCode session and bridges every tool permission request (`read`, `edit`, `bash`, `webfetch`) directly through OpenCode's native `ctx.permission.assert(...)` rules and interactive prompts.

**Only invoke `agy` when the user explicitly requests using `agy` / Antigravity (or runs `/agy`). Do not call it proactively.**

Nothing `agy` produces is verified. Reading diffs, checking files, and running tests yourself is your job, not `agy`'s.

## Writing the brief

`agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Write a self-contained brief, not a vague wish:

- **Give paths, not huge file dumps:** Provide exact workspace-relative or absolute paths `agy` can read directly.
- **State edit vs. read-only intent:** Explicitly tell `agy` whether it should only analyze/review or is allowed to edit files and run commands.
- **Define the finish line:** Specify constraints (language, style, what not to touch) and what to include in its final reply (changed files, diff/summary, verification commands run, remaining issues).
- **Avoid leading `/` in prompts:** `agy` expands slash commands/skills when a prompt begins with `/` (or leading whitespace/newlines followed by `/`). Always start the prompt with a normal word (e.g., `Review the diff`, not `/review`).
- **Wait for subagents:** If delegating complex work, ask `agy` to wait for any internal subagents before finishing so its final response contains the complete result.

## Model selection (`gemini-4` and `claude-5-5` families only)

Only use models from the **`gemini-4`** and **`claude-5-5`** families:

- `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}`
- `{gemini-4-argon|claude-opus-5-5|claude-sonnet-5-5}-{low|medium|high}`

| Model family | Effort levels | Best used for |
| --- | --- | --- |
| `gemini-4-hydrogen-*` | `low`, `medium`, `high`, `xhigh` | Fast agentic workhorse: bulk implementation, scaffolding, test generation, multi-file edits. |
| `gemini-4-argon-*` | `low`, `medium`, `high` | General-purpose coding, codebase exploration, and balanced analysis. |
| `gemini-4-neon-*` | `low`, `medium`, `high`, `xhigh` | Frontier reasoning, complex architecture, and deep debugging. |
| `claude-sonnet-5-5-*` | `low`, `medium`, `high` | Careful code reviews, correctness-focused edits, and clean refactors. |
| `claude-opus-5-5-*` | `low`, `medium`, `high` | Hardest refactors, gnarly bugs, and second-opinion reviews on risky diffs. |

## Session continuity & timeouts

- **Warm follow-ups:** Omit `session_id` and `new_session` to continue the active `agy` session mapped to the current OpenCode session.
- **Unrelated tasks:** Pass `new_session: true` so prior context does not bleed into a fresh task.
- **Resuming a specific session:** Pass `session_id` (from `metadata.agySessionId`) to resume a timed-out turn or an `agy` session from an earlier run (uses ACP `session/load`).
- **Timeouts:** Default `timeout_ms` is 15 minutes (`900000`), max 4 hours (`14400000`). On `AGY_ERROR [TIMEOUT]`, do **not** restart from scratch — pass `session_id` from `metadata.agySessionId` and `timeout_ms` from `metadata.suggestedNextTimeoutMs` with a continuation prompt (e.g., `"Continue from where you left off and finish the task."`).

## Handling `AGY_ERROR [CODE]`

| Code | Next move |
| --- | --- |
| `TIMEOUT` | Resume with `session_id` (`metadata.agySessionId`) and `timeout_ms` (`metadata.suggestedNextTimeoutMs`). |
| `AUTH_REQUIRED` | `agy` is not signed in. Stop and ask the user to run `agy` interactively to log in. Do not retry in a loop. |
| `QUOTA_EXHAUSTED` | Rate limit or quota hit. Report it to the user and wait; do not retry in a loop. |
| `MODEL_NOT_FOUND` | Selected model is unavailable for this account. Switch to another `gemini-4-*` or `claude-*-5-5-*` model (or omit `model` to use `agy`'s default). |
| `AGY_NOT_FOUND` | `agy` binary is not on `PATH` (or `AGY_BIN` is invalid). Report to the user; do not retry. |
| `INVALID_ARGUMENT` | Fix the tool arguments (e.g., non-empty `prompt`) before retrying. |
| `AGY_FAILED` | Inspect the error details and stderr tail before deciding whether to retry once or handle directly. |

## After `agy` returns

Inspect the changed files or diff, run tests/typechecks yourself, and confirm the work actually landed as requested. Treat `agy`'s summary as a claim until verified. If something is wrong, fix it directly or send one targeted follow-up in the same warm `agy` session.
