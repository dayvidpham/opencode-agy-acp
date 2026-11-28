// Lightweight file-backed live trace store shared between the server plugin
// (`src/index.ts`) and TUI plugin (`src/tui.tsx`).
//
// Needed because OpenCode 2.x Code Mode (`execute`) replaces child tools'
// `context.progress` with a no-op (`() => Effect.void`), so nested `agy` calls
// inside `execute` cannot stream progress through `part.state.metadata`.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

export type AgyTraceStatus =
  | "streaming"
  | "running"
  | "completed"
  | "error"
  | "cancelled";

export interface AgyTraceRun {
  readonly id: string;
  readonly status: AgyTraceStatus;
  readonly background?: boolean;
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

export type AgyRunControlAction = "cancel" | "background";

export interface AgyRunControlRequest {
  readonly id: string;
  readonly runId: string;
  readonly action: AgyRunControlAction;
  readonly requestedAt: number;
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

export function controlFilePath(
  sessionID: string,
  dir: string = defaultTraceDir(),
): string {
  return path.join(dir, `${sanitizeSessionId(sessionID)}.ctl.json`);
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

export function getSessionControlMtime(
  sessionID: string,
  dir: string = defaultTraceDir(),
): number {
  try {
    return statSync(controlFilePath(sessionID, dir)).mtimeMs;
  } catch {
    return 0;
  }
}

export function requestRunControl(
  sessionID: string,
  runId: string,
  action: AgyRunControlAction,
  dir: string = defaultTraceDir(),
): void {
  if (!sessionID || !runId) return;
  try {
    mkdirSync(dir, { recursive: true });
    const file = controlFilePath(sessionID, dir);
    const now = Date.now();
    let existing: AgyRunControlRequest[] = [];
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as { requests?: unknown };
      if (Array.isArray(parsed?.requests)) {
        existing = (parsed.requests as AgyRunControlRequest[]).filter(
          (req) =>
            req &&
            typeof req.runId === "string" &&
            (req.action === "cancel" || req.action === "background") &&
            typeof req.requestedAt === "number" &&
            now - req.requestedAt < 60_000,
        );
      }
    } catch {
      // No existing control file yet.
    }
    existing.push({
      id: `${process.pid}-${now}-${++tmpSeq}`,
      runId,
      action,
      requestedAt: now,
    });
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, requests: existing }), "utf8");
    renameSync(tmp, file);
  } catch {
    // Control signaling is best-effort and must never crash the TUI.
  }
}

export function takeSessionControlRequests(
  sessionID: string,
  dir: string = defaultTraceDir(),
): AgyRunControlRequest[] {
  if (!sessionID) return [];
  const file = controlFilePath(sessionID, dir);
  const claim = `${file}.${process.pid}.${++tmpSeq}.claim`;
  try {
    renameSync(file, claim);
  } catch {
    return [];
  }
  try {
    const raw = readFileSync(claim, "utf8");
    const parsed = JSON.parse(raw) as { requests?: unknown };
    if (!Array.isArray(parsed?.requests)) return [];
    return (parsed.requests as AgyRunControlRequest[]).filter(
      (req) =>
        req &&
        typeof req.runId === "string" &&
        (req.action === "cancel" || req.action === "background"),
    );
  } catch {
    return [];
  } finally {
    try {
      rmSync(claim, { force: true });
    } catch {
      // ignore
    }
  }
}

export interface CollapsedTraceStep {
  readonly step: AgyTraceToolCall;
  readonly icon: string;
  readonly text: string;
  readonly isError: boolean;
  readonly count: number;
}

export function stepIcon(status: string | undefined): string {
  const st = (status ?? "").toLowerCase();
  if (st === "completed" || st === "done") return "✓";
  if (st === "failed" || st === "error" || st === "cancelled") return "✗";
  return "›";
}

export function isStepError(status: string | undefined): boolean {
  const st = (status ?? "").toLowerCase();
  return st === "failed" || st === "error" || st === "cancelled";
}

export function formatStepText(step: AgyTraceToolCall): string {
  const title = step.title.replace(/\s+/g, " ").trim();
  const detail = step.detail?.replace(/\s+/g, " ").trim();
  if (!detail || detail === title) return title;
  const prefix = detail.endsWith("…") ? detail.slice(0, -1).trim() : detail;
  if (prefix.length > 0 && title.startsWith(prefix)) return title;
  return `${title} — ${detail}`;
}

export function collapseConsecutiveSteps(
  steps: readonly AgyTraceToolCall[],
): CollapsedTraceStep[] {
  const out: CollapsedTraceStep[] = [];
  for (const step of steps) {
    const icon = stepIcon(step.status);
    const text = formatStepText(step);
    const isError = isStepError(step.status);
    const prev = out[out.length - 1];
    if (prev && prev.icon === icon && prev.text === text && prev.isError === isError) {
      out[out.length - 1] = { ...prev, count: prev.count + 1 };
    } else {
      out.push({ step, icon, text, isError, count: 1 });
    }
  }
  return out;
}
