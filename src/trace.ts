// Lightweight file-backed live trace store shared between the server plugin
// (`src/index.ts`) and TUI plugin (`src/tui.tsx`).
//
// Needed because OpenCode 2.x Code Mode (`execute`) replaces child tools'
// `context.progress` with a no-op (`() => Effect.void`), so nested `agy` calls
// inside `execute` cannot stream progress through `part.state.metadata`.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface AgyTraceToolCall {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly status?: string;
  readonly detail?: string;
}

export interface AgyTracePlanEntry {
  readonly content: string;
  readonly status?: string;
  readonly priority?: string;
}

export interface AgyTraceRun {
  readonly id: string;
  readonly status: "streaming" | "running" | "completed" | "error";
  readonly prompt: string;
  readonly agySessionId?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
  readonly currentActivity?: string;
  readonly toolCallCount: number;
  readonly toolCalls: readonly AgyTraceToolCall[];
  readonly plan: readonly AgyTracePlanEntry[];
  readonly latestThought?: string;
  readonly latestText?: string;
  readonly charsReceived: number;
  readonly errorMessage?: string;
}

const MAX_RUNS_PER_SESSION = 30;
let tmpSeq = 0;

export function defaultTraceDir(): string {
  return path.join(tmpdir(), "opencode-agy-acp-traces");
}

function sanitizeSessionId(sessionID: string): string {
  const clean = sessionID.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return clean || "default";
}

export function traceFilePath(
  sessionID: string,
  dir: string = defaultTraceDir(),
): string {
  return path.join(dir, `${sanitizeSessionId(sessionID)}.json`);
}

export function writeSessionTraces(
  sessionID: string,
  runs: readonly AgyTraceRun[],
  dir: string = defaultTraceDir(),
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = traceFilePath(sessionID, dir);
    const trimmed = runs.slice(-MAX_RUNS_PER_SESSION);
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: trimmed }), "utf8");
    renameSync(tmp, file);
  } catch {
    // Tracing must never break tool execution.
  }
}

export function getSessionTraceMtime(
  sessionID: string,
  dir: string = defaultTraceDir(),
): number {
  try {
    return statSync(traceFilePath(sessionID, dir)).mtimeMs;
  } catch {
    return 0;
  }
}

export function readSessionTraces(
  sessionID: string,
  dir: string = defaultTraceDir(),
): AgyTraceRun[] {
  try {
    const raw = readFileSync(traceFilePath(sessionID, dir), "utf8");
    const parsed = JSON.parse(raw) as { runs?: unknown };
    if (!Array.isArray(parsed?.runs)) return [];
    return parsed.runs as AgyTraceRun[];
  } catch {
    return [];
  }
}
