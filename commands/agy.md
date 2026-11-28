---
description: Delegate a task to Google Antigravity (`agy acp`)
---
Delegate the following explicitly requested task to the `agy` tool (`opencode-agy-acp`):

$ARGUMENTS

Guidelines:
- Load the `opencode-agy-acp` skill if you need detailed model selection, resume, or error-recovery guidance.
- Only use `gemini-4` and `claude-5-5` models, preferring Gemini 4 by default: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}`, `gemini-4-argon-{low|medium|high}`; secondary: `claude-{opus|sonnet}-5-5-{low|medium|high}`.
- Write a self-contained brief with exact file paths, read-only vs. edit intent, and what summary/verification to return.
- Watch leading `/`: `agy` parses a leading `/` (even after leading whitespace) as one of its own slash commands (`/goal`, `/compact`). Use `/goal <brief>` intentionally for multi-step checklists, and do not start prompts with OpenCode-only role commands (`/worker`, `/architect`, `/reviewer`, `/review`) — describe the role/task in words and pass any `SKILL.md` path instead.
- If the user asks to run `agy` asynchronously / in the background, pass `background: true` (or `wait_ms`), do not poll `agy_job` in a loop, and wait for the automatic synthetic completion wakeup — never send duplicate `"continue"` prompts into an active session that is still waiting on background commands or subagents.
- After `agy` returns, inspect the diff/files and verify the result yourself — never assume `agy`'s output is verified.
