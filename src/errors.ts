// Structured error classification and formatting for `opencode-agy-acp`.

export type AgyErrorCode =
  | "TIMEOUT"
  | "AUTH_REQUIRED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_NOT_FOUND"
  | "SESSION_LOAD_FAILED"
  | "AGY_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "AGY_FAILED";

export interface AgyErrorFormatContext {
  readonly agySessionId?: string;
  readonly timeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly partialOutput?: string;
  readonly stderrTail?: string;
  readonly toolCalls?: readonly unknown[];
}

export interface FormattedAgyErrorResult {
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const DEFAULT_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MIN_SUGGESTED_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Scrubs common secret/token shapes before returning diagnostic text to the model.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9._-]{12,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED]");
}

export function classifyAgyError(
  error: unknown,
  stderrTail = "",
): AgyErrorCode {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const combined = `${rawMessage}\n${stderrTail}`;

  if (rawMessage.startsWith("AGY_ACP_TIMEOUT:")) {
    return "TIMEOUT";
  }
  if (rawMessage.startsWith("AGY_INVALID_ARGUMENT:")) {
    return "INVALID_ARGUMENT";
  }
  if (rawMessage.startsWith("AGY_SESSION_LOAD_FAILED:")) {
    return "SESSION_LOAD_FAILED";
  }
  if (
    /\bENOENT\b/i.test(combined) ||
    /executable not found|command not found|no such file or directory.*agy/i.test(combined)
  ) {
    return "AGY_NOT_FOUND";
  }
  if (
    /\b401\b|\bunauthenticated\b|not logged in|auth(?:entication)? required|please log in|sign in/i.test(
      combined,
    )
  ) {
    return "AUTH_REQUIRED";
  }
  if (
    /\b429\b|quota|rate[\s_-]?limit|resource_exhausted|too many requests/i.test(
      combined,
    )
  ) {
    return "QUOTA_EXHAUSTED";
  }
  if (
    /model[_\s-]?not[_\s-]?found|unknown model|invalid model|unsupported model/i.test(
      combined,
    )
  ) {
    return "MODEL_NOT_FOUND";
  }
  return "AGY_FAILED";
}

function nextMoveHint(
  code: AgyErrorCode,
  agySessionId?: string,
  suggestedNextTimeoutMs?: number,
): string {
  switch (code) {
    case "TIMEOUT":
      return agySessionId
        ? `Resume this exact session with session_id="${agySessionId}"${suggestedNextTimeoutMs ? ` and timeout_ms=${suggestedNextTimeoutMs}` : ""} instead of starting over.`
        : "Narrow the task scope or increase timeout_ms before retrying.";
    case "AUTH_REQUIRED":
      return "Not signed in to `agy`. Stop and ask the user to run `agy` interactively to log in. Do not retry in a loop.";
    case "QUOTA_EXHAUSTED":
      return "Quota or rate limit reached. Report this to the user and wait for reset. Do not retry in a loop.";
    case "MODEL_NOT_FOUND":
      return "Model unavailable for this account. Pick another `gemini-4-*` or `claude-*-5-5-*` model, or omit `model` to use the default.";
    case "SESSION_LOAD_FAILED":
      return "The requested `session_id` could not be loaded. Verify the ID or omit `session_id` to start a fresh `agy` session.";
    case "AGY_NOT_FOUND":
      return "`agy` binary was not found on PATH (or AGY_BIN is invalid). Report this to the user; retrying will not help.";
    case "INVALID_ARGUMENT":
      return "Fix the invalid tool arguments before retrying.";
    case "AGY_FAILED":
      return "Inspect the error message and stderr tail before deciding whether to retry once or handle the task directly.";
  }
}

export function formatAgyErrorResult(
  error: unknown,
  ctx: AgyErrorFormatContext = {},
): FormattedAgyErrorResult {
  const code = classifyAgyError(error, ctx.stderrTail);
  const rawMessage = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const cleanMessage = scrubSecrets(
    rawMessage.replace(/^AGY_(?:INVALID_ARGUMENT|SESSION_LOAD_FAILED):\s*/, ""),
  );
  const maxTimeoutMs = ctx.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const suggestedNextTimeoutMs =
    code === "TIMEOUT" && typeof ctx.timeoutMs === "number"
      ? Math.min(maxTimeoutMs, Math.max(ctx.timeoutMs * 2, MIN_SUGGESTED_TIMEOUT_MS))
      : undefined;

  const lines: string[] = [
    `AGY_ERROR [${code}]`,
    cleanMessage,
    nextMoveHint(code, ctx.agySessionId, suggestedNextTimeoutMs),
  ];

  if (ctx.partialOutput && ctx.partialOutput.trim() !== "") {
    lines.push("", "Partial output so far:", ctx.partialOutput.trim());
  }

  const stderrTrimmed = ctx.stderrTail?.trim();
  if (stderrTrimmed && code !== "TIMEOUT") {
    lines.push("", "stderr tail:", scrubSecrets(stderrTrimmed.slice(-2_000)));
  }

  if (ctx.agySessionId) {
    lines.push("", `[agy_session_id: ${ctx.agySessionId}]`);
  }

  return {
    content: lines.join("\n"),
    metadata: {
      error: true,
      code,
      ...(ctx.agySessionId ? { agySessionId: ctx.agySessionId } : {}),
      ...(code === "TIMEOUT" ? { timedOut: true } : {}),
      ...(suggestedNextTimeoutMs !== undefined
        ? { suggestedNextTimeoutMs }
        : {}),
      ...(ctx.toolCalls ? { toolCalls: ctx.toolCalls } : {}),
    },
  };
}
