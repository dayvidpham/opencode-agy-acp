---
description: Delegate a task to Google Antigravity (`agy acp`)
---
Delegate the following explicitly requested task to the `agy` tool (`opencode-agy-acp`):

$ARGUMENTS

Guidelines:
- Load the `opencode-agy-acp` skill if you need detailed model selection, resume, or error-recovery guidance.
- Only use models from the `gemini-4` and `claude-5-5` families: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}` or `{gemini-4-argon|claude-opus-5-5|claude-sonnet-5-5}-{low|medium|high}`.
- Write a self-contained brief with exact file paths, read-only vs. edit intent, and what summary/verification to return.
- Start the `agy` prompt with a normal word (never a leading `/`, which triggers `agy` slash-command expansion).
- After `agy` returns, inspect the diff/files and verify the result yourself — never assume `agy`'s output is verified.
