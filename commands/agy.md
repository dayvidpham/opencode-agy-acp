---
description: Delegate a task to Google Antigravity (`agy acp`)
---
Delegate the following explicitly requested task to the `agy` tool (`opencode-agy-acp`):

$ARGUMENTS

Guidelines:
- Load the `opencode-agy-acp` skill if you need detailed model selection, resume, or error-recovery guidance.
- Only use `gemini-4` and `claude-5-5` models, preferring Gemini 4 by default: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}`, `gemini-4-argon-{low|medium|high}`; secondary: `claude-{opus|sonnet}-5-5-{low|medium|high}`.
- Write a self-contained brief with exact file paths, read-only vs. edit intent, and what summary/verification to return.
- Start the `agy` prompt with a normal word (never a leading `/`, which triggers `agy` slash-command expansion).
- If the user asks to run `agy` asynchronously / in the background, pass `background: true` (or `wait_ms`), do not poll `agy_job` in a loop, and wait for the automatic synthetic completion wakeup (using `agy_job` only when explicit `list`/`wait`/`cancel` control is needed).
- After `agy` returns, inspect the diff/files and verify the result yourself — never assume `agy`'s output is verified.
