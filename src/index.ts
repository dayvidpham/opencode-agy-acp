// OpenCode 2.0 plugin that drives Google Antigravity CLI (`agy acp`) over
// the Agent Client Protocol (ACP) with native OpenCode permission bridging
// and background job execution.
//
// Zero runtime npm imports: runs directly on OpenCode's Bun runtime.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpClient, type AcpSpawner } from "./acp.ts";
import { formatAgyErrorResult } from "./errors.ts";
import {
  handleAcpPermissionRequest,
  type OpenCodePermissionAssertInput,
} from "./permissions.ts";
import {
  defaultTraceDir,
  getSessionControlMtime,
  readSessionTraces,
  takeSessionControlRequests,
  writeSessionTraces,
  type AgyTraceRun,
} from "./trace.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_OUTPUT_CHARS = 120_000;
const CONTROL_POLL_INTERVAL_MS = 200;
const HEARTBEAT_INTERVAL_MS = 2_500;
const MAX_STORED_JOBS_PER_SESSION = 30;

const SKILL_ID = "opencode-agy-acp";
const SKILL_NAME = "opencode-agy-acp";
const SKILL_FILE_PATH = fileURLToPath(
  new URL("../skills/opencode-agy-acp/SKILL.md", import.meta.url),
);
const COMMAND_FILE_PATH = fileURLToPath(
  new URL("../commands/agy.md", import.meta.url),
);

export interface ParsedMarkdownAsset {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

export function parseFrontmatterMarkdown(markdown: string): ParsedMarkdownAsset {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error("Markdown asset must start with a '---' frontmatter block");
  }
  const closeIdx = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closeIdx === -1) {
    throw new Error("Markdown asset frontmatter block is not closed");
  }
  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) frontmatter[key] = value;
  }
  const body = lines.slice(closeIdx + 1).join("\n").trim();
  return { frontmatter, body };
}

export function buildAgyCommandPrompt(
  template: string,
  userArguments: string,
): string {
  const trimmed = userArguments.trim();
  const replacement =
    trimmed || "(No task provided — ask the user what they want delegated to `agy`.)";
  return template.includes("$ARGUMENTS")
    ? template.replace("$ARGUMENTS", replacement)
    : `${template}\n\n${replacement}`;
}

export interface AgyToolInput {
  readonly prompt: string;
  readonly session_id?: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly timeout_ms?: number;
  readonly background?: boolean;
  readonly wait_ms?: number;
}

export interface AgyJobToolInput {
  readonly action: "list" | "status" | "wait" | "cancel";
  readonly job_id?: string;
  readonly timeout_ms?: number;
}

export interface OpenCodeToolResult {
  readonly content?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OpenCodeToolContextLike {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (update: Readonly<Record<string, unknown>>) => Promise<void>;
}

export interface OpenCodeCommandInvocationLike {
  readonly sessionID: string;
  readonly prompt: {
    readonly text: string;
    readonly files?: readonly unknown[];
  };
  readonly delivery?: "steer" | "queue" | null;
}

export interface OpenCodePluginContextLike {
  readonly location?: { readonly directory?: string };
  readonly permission: {
    readonly assert: (input: OpenCodePermissionAssertInput) => Promise<void>;
  };
  readonly tool: {
    readonly transform: (
      fn: (tools: {
        add: (tool: {
          readonly name: string;
          readonly description: string;
          readonly input: Record<string, unknown>;
          readonly execute: (
            input: unknown,
            context: OpenCodeToolContextLike,
          ) => Promise<OpenCodeToolResult>;
        }) => void;
      }) => void,
    ) => Promise<{ dispose(): Promise<void> | void }>;
  };
  readonly command?: {
    readonly transform: (
      fn: (commands: {
        add: (command: {
          readonly name: string;
          readonly description?: string;
          readonly execute: (
            input: OpenCodeCommandInvocationLike,
          ) => Promise<void>;
        }) => void;
      }) => void,
    ) => Promise<{ dispose(): Promise<void> | void }>;
  };
  readonly skill?: {
    readonly transform: (
      fn: (skills: {
        get?: (id: string) => Record<string, unknown> | undefined;
        add: (skill: {
          readonly id: string;
          readonly name: string;
          readonly description?: string;
          readonly path: string;
          readonly content: string;
        }) => void;
        update?: (
          id: string,
          update: (skill: Record<string, unknown>) => void,
        ) => void;
      }) => void,
    ) => Promise<{ dispose(): Promise<void> | void }>;
  };
  readonly session?: {
    readonly prompt?: (input: {
      readonly sessionID: string;
      readonly text: string;
      readonly files?: readonly unknown[];
      readonly delivery?: "steer" | "queue" | null;
    }) => Promise<unknown>;
    readonly synthetic?: (input: {
      readonly sessionID: string;
      readonly text: string;
      readonly delivery?: "steer" | "queue";
      readonly resume?: boolean;
    }) => Promise<unknown>;
  };
}

export interface AgyToolCallSummary {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly status?: string;
  readonly detail?: string;
}

export interface AgyPlanEntry {
  readonly content: string;
  readonly status?: string;
  readonly priority?: string;
}

interface TurnAccumulator {
  text: string;
  thoughts: string;
  plan: AgyPlanEntry[];
  readonly toolCalls: Map<string, AgyToolCallSummary>;
}

type CancelSource = "opencode" | "job_tool" | "tui";

interface AgyJobRecord {
  readonly id: string;
  readonly openCodeSessionId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly startedAt: number;
  agySessionId?: string;
  background: boolean;
  status: "running" | "completed" | "error" | "cancelled";
  completedAt?: number;
  result?: OpenCodeToolResult;
  rethrowError?: unknown;
  resultDelivered: boolean;
  readonly snapshot: () => AgyTraceRun;
  readonly moveToBackground: (reason: "input" | "wait_ms" | "tui") => boolean;
  readonly cancel: (source: CancelSource) => void;
  readonly settled: Promise<void>;
  readonly waiters: Set<() => void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function truncateOneLine(text: string, maxChars: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxChars) return single;
  return single.slice(0, Math.max(1, maxChars - 1)) + "…";
}

function lastNonEmptyLine(text: string, maxChars: number): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim();
    if (trimmed) return truncateOneLine(trimmed, maxChars);
  }
  return undefined;
}

function isRedundantDetail(title: string, detail: string): boolean {
  const normTitle = title.replace(/\s+/g, " ").trim();
  const normDetail = detail.replace(/\s+/g, " ").trim();
  if (!normDetail) return true;
  if (normDetail === normTitle) return true;
  const prefix = normDetail.endsWith("…")
    ? normDetail.slice(0, -1).trim()
    : normDetail;
  return prefix.length > 0 && normTitle.startsWith(prefix);
}

function extractToolDetail(update: Record<string, unknown>): string | undefined {
  if (Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      const p = nonEmptyString(asRecord(loc)?.path);
      if (p) return truncateOneLine(p, 120);
    }
  }
  const input = asRecord(update.rawInput) ?? asRecord(update.args);
  if (input) {
    for (const key of [
      "command",
      "CommandLine",
      "cmd",
      "path",
      "Path",
      "file_path",
      "filePath",
      "TargetFile",
      "AbsolutePath",
      "pattern",
      "query",
      "url",
      "Url",
      "description",
    ]) {
      const val = nonEmptyString(input[key]);
      if (val) return truncateOneLine(val, 120);
    }
  }
  return undefined;
}

/**
 * Extracts text chunks, thoughts, plan entries, and tool call progress from
 * ACP `session/update` notifications. Handles both the ACP
 * `params.update.sessionUpdate` envelope and flat `ContentBlock[]` payloads.
 *
 * Returns `true` when a structural step update (tool call or plan change) was
 * applied so callers can flush progress immediately.
 */
export function applySessionUpdate(
  acc: TurnAccumulator,
  params: Record<string, unknown>,
): boolean {
  const update = asRecord(params.update);

  if (update) {
    const kind =
      typeof update.sessionUpdate === "string"
        ? update.sessionUpdate
        : typeof update.type === "string"
          ? update.type
          : "";

    if (kind === "agent_message_chunk") {
      const content = asRecord(update.content);
      if (content?.type === "text" && typeof content.text === "string") {
        acc.text += content.text;
      } else if (typeof update.text === "string") {
        acc.text += update.text;
      }
      return false;
    }

    if (kind === "agent_thought_chunk") {
      const content = asRecord(update.content);
      if (content?.type === "text" && typeof content.text === "string") {
        acc.thoughts += content.text;
      } else if (typeof update.text === "string") {
        acc.thoughts += update.text;
      }
      return false;
    }

    if (kind === "plan" && Array.isArray(update.entries)) {
      const entries: AgyPlanEntry[] = [];
      for (const rawEntry of update.entries) {
        const entry = asRecord(rawEntry);
        const content = nonEmptyString(entry?.content);
        if (!content) continue;
        entries.push({
          content: truncateOneLine(content, 160),
          status: nonEmptyString(entry?.status),
          priority: nonEmptyString(entry?.priority),
        });
      }
      acc.plan = entries;
      return true;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const id =
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : `tc-${acc.toolCalls.size + 1}`;
      const prev = acc.toolCalls.get(id);
      const title =
        typeof update.title === "string" && update.title.trim() !== ""
          ? update.title.trim()
          : typeof update.name === "string" && update.name.trim() !== ""
            ? update.name.trim()
            : (prev?.title ?? "tool");
      const rawDetail = extractToolDetail(update) ?? prev?.detail;
      const detail =
        rawDetail && !isRedundantDetail(title, rawDetail)
          ? rawDetail
          : undefined;
      acc.toolCalls.set(id, {
        id,
        title,
        kind: typeof update.kind === "string" ? update.kind : prev?.kind,
        status:
          typeof update.status === "string" ? update.status : prev?.status,
        ...(detail ? { detail } : {}),
      });
      return true;
    }
  }

  // Fallback: flat ContentBlock[] format (as modeled in pasture/internal/acp)
  let structural = false;
  if (Array.isArray(params.content)) {
    for (const rawBlock of params.content) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        acc.text += block.text;
      } else if (block.type === "thinking" && typeof block.text === "string") {
        acc.thoughts += block.text;
      } else if (block.type === "tool_use") {
        const id =
          typeof block.id === "string"
            ? block.id
            : `tc-${acc.toolCalls.size + 1}`;
        const detail = extractToolDetail(block);
        acc.toolCalls.set(id, {
          id,
          title: typeof block.name === "string" ? block.name : "tool",
          status: "running",
          ...(detail ? { detail } : {}),
        });
        structural = true;
      }
    }
  }
  return structural;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function normalizeWaitMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.floor(value)));
}

function truncateTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `[...${omitted} chars truncated...]\n` + text.slice(-limit);
}

function formatElapsedSeconds(startedAt: number, endedAt = Date.now()): string {
  const secs = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function formatDetachedLaunchResult(
  job: AgyJobRecord,
  reason: "input" | "wait_ms" | "tui",
  modelWarning?: string,
): OpenCodeToolResult {
  const snap = job.snapshot();
  const reasonLine =
    reason === "wait_ms"
      ? "`agy` exceeded `wait_ms` and moved to the background."
      : reason === "tui"
        ? "`agy` was moved to the background from `/agy-trace`."
        : "Started `agy` in the background.";

  const lines: string[] = [];
  if (modelWarning) {
    lines.push(`[Note: model override failed: ${modelWarning}]`, "");
  }
  lines.push(
    reasonLine,
    `- job_id: ${job.id}`,
    ...(job.agySessionId ? [`- agy_session_id: ${job.agySessionId}`] : []),
    ...(job.model ? [`- model: ${job.model}`] : []),
    `- status: running`,
    ...(snap.toolCallCount > 0
      ? [`- progress: ${snap.toolCallCount} ${snap.toolCallCount === 1 ? "step" : "steps"} (${snap.currentActivity ?? "working"})`]
      : []),
    "",
    "OpenCode will receive a completion notification automatically when this background `agy` run finishes. Do NOT poll `agy_job` in a loop — continue independent work or end your turn and wait for the wakeup (use `agy_job` only for explicit `list` / `wait` / `cancel` control).",
    "",
    `[agy_job_id: ${job.id}]`,
    ...(job.agySessionId ? [`[agy_session_id: ${job.agySessionId}]`] : []),
  );

  return {
    content: lines.join("\n"),
    metadata: {
      background: true,
      detachedReason: reason,
      status: "running",
      jobId: job.id,
      ...(job.agySessionId ? { agySessionId: job.agySessionId } : {}),
      startedAt: job.startedAt,
      ...(job.model ? { model: job.model } : {}),
      toolCallCount: snap.toolCallCount,
      currentActivity: snap.currentActivity,
      ...(modelWarning ? { modelWarning } : {}),
    },
  };
}

function formatJobStatusResult(job: AgyJobRecord): OpenCodeToolResult {
  if (job.status !== "running" && job.result) {
    job.resultDelivered = true;
    return {
      content: [
        `[agy_job ${job.id}: ${job.status} in ${formatElapsedSeconds(job.startedAt, job.completedAt)}]`,
        "",
        job.result.content ?? "",
      ].join("\n"),
      metadata: {
        ...(job.result.metadata ?? {}),
        jobId: job.id,
        status: job.status,
        background: job.background,
      },
    };
  }

  const snap = job.snapshot();
  const recentSteps = snap.toolCalls
    .slice(-8)
    .map(
      (t) =>
        `  - ${t.title}${t.detail ? ` (${t.detail})` : ""}${t.status ? ` [${t.status}]` : ""}`,
    );

  const lines: string[] = [
    `agy job "${job.id}" is ${job.status}${job.background ? " (background)" : " (foreground)"}`,
    `- elapsed: ${formatElapsedSeconds(job.startedAt, job.completedAt)}`,
    ...(job.agySessionId ? [`- agy_session_id: ${job.agySessionId}`] : []),
    ...(job.model ? [`- model: ${job.model}`] : []),
    `- activity: ${snap.currentActivity ?? "Working…"}`,
    `- steps: ${snap.toolCallCount}`,
    `- prompt: ${truncateOneLine(job.prompt, 160)}`,
  ];

  if (recentSteps.length > 0) {
    lines.push("", "Recent steps:", ...recentSteps);
  }
  if (snap.latestThought) {
    lines.push("", `Latest thought: ${snap.latestThought}`);
  }
  if (snap.latestText) {
    lines.push("", `Latest output: ${snap.latestText}`);
  }
  lines.push(
    "",
    `[agy_job_id: ${job.id}]`,
    ...(job.agySessionId ? [`[agy_session_id: ${job.agySessionId}]`] : []),
  );

  return {
    content: lines.join("\n"),
    metadata: {
      jobId: job.id,
      status: job.status,
      background: job.background,
      ...(job.agySessionId ? { agySessionId: job.agySessionId } : {}),
      startedAt: job.startedAt,
      ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
      ...(job.model ? { model: job.model } : {}),
      currentActivity: snap.currentActivity,
      toolCallCount: snap.toolCallCount,
      toolCalls: snap.toolCalls,
      plan: snap.plan,
    },
  };
}

export interface CreatePluginOptions {
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly spawn?: AcpSpawner;
  readonly env?: Record<string, string | undefined>;
  readonly traceDir?: string | false;
}

export function createAgyAcpPlugin(pluginOptions: CreatePluginOptions = {}) {
  return {
    id: "dayvidpham.opencode-agy-acp",
    setup: async (ctx: OpenCodePluginContextLike) => {
      const defaultCwd = ctx?.location?.directory || process.cwd();
      const traceDir =
        pluginOptions.traceDir === false
          ? undefined
          : (pluginOptions.traceDir ?? defaultTraceDir());

      // Mirrors live per-session run state to disk so the TUI plugin sees steps
      // both for background runs and when OpenCode Code Mode (`execute`)
      // replaces `toolCtx.progress` with a no-op.
      const sessionTraces = new Map<string, Map<string, AgyTraceRun>>();
      const jobsBySession = new Map<string, Map<string, AgyJobRecord>>();
      const activeRuns = new Map<string, AgyJobRecord>();
      const usedRunIds = new Set<string>();
      const lastControlMtime = new Map<string, number>();
      let runSeq = 0;
      let lastHeartbeatAt = 0;
      let controlTimer: ReturnType<typeof setInterval> | undefined;

      const recordTrace = (sessionID: string, run: AgyTraceRun) => {
        if (!traceDir || !sessionID) return;
        let runs = sessionTraces.get(sessionID);
        if (!runs) {
          runs = new Map(
            readSessionTraces(sessionID, traceDir).map((existing) => [
              existing.id,
              existing,
            ]),
          );
          sessionTraces.set(sessionID, runs);
        }
        runs.set(run.id, run);
        writeSessionTraces(sessionID, Array.from(runs.values()), traceDir);
      };

      const getSessionJobMap = (sessionID: string): Map<string, AgyJobRecord> => {
        let map = jobsBySession.get(sessionID);
        if (!map) {
          map = new Map();
          jobsBySession.set(sessionID, map);
        }
        return map;
      };

      const pruneSettledJobs = (sessionID: string) => {
        const map = jobsBySession.get(sessionID);
        if (!map || map.size <= MAX_STORED_JOBS_PER_SESSION) return;
        for (const [id, rec] of map.entries()) {
          if (map.size <= MAX_STORED_JOBS_PER_SESSION) break;
          if (rec.status !== "running") {
            map.delete(id);
          }
        }
      };

      const pollControlAndHeartbeat = () => {
        if (activeRuns.size === 0) {
          if (controlTimer !== undefined) {
            clearInterval(controlTimer);
            controlTimer = undefined;
          }
          return;
        }

        if (traceDir) {
          const activeSessions = new Set<string>();
          for (const run of activeRuns.values()) {
            if (run.openCodeSessionId) activeSessions.add(run.openCodeSessionId);
          }

          for (const sid of activeSessions) {
            const mtime = getSessionControlMtime(sid, traceDir);
            if (mtime > 0 && mtime !== lastControlMtime.get(sid)) {
              lastControlMtime.set(sid, mtime);
              const requests = takeSessionControlRequests(sid, traceDir);
              for (const req of requests) {
                const target = activeRuns.get(req.runId);
                if (!target || target.openCodeSessionId !== sid) continue;
                if (req.action === "cancel") {
                  target.cancel("tui");
                } else if (req.action === "background") {
                  target.moveToBackground("tui");
                }
              }
            }
          }

          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatAt = now;
            for (const run of activeRuns.values()) {
              if (run.status === "running") {
                recordTrace(run.openCodeSessionId, run.snapshot());
              }
            }
          }
        }
      };

      const ensureControlLoop = () => {
        if (controlTimer !== undefined || activeRuns.size === 0) return;
        lastHeartbeatAt = Date.now();
        controlTimer = setInterval(
          pollControlAndHeartbeat,
          CONTROL_POLL_INTERVAL_MS,
        );
        controlTimer.unref?.();
      };

      const notifyBackgroundCompletion = async (
        job: AgyJobRecord,
        cancelSource?: CancelSource,
      ) => {
        if (!job.background || job.resultDelivered || !job.openCodeSessionId) {
          return;
        }

        // If a caller is actively awaiting `agy_job({ action: "wait" })`, let
        // that tool call return the payload directly instead of duplicating it
        // in a synthetic message.
        if (job.waiters.size > 0) {
          job.resultDelivered = true;
          return;
        }

        // Explicit cancellation via `agy_job({ action: "cancel" })` already
        // returns confirmation directly to the caller.
        if (cancelSource === "job_tool") {
          job.resultDelivered = true;
          return;
        }

        // If the user cancelled the background job from `/agy-trace`, record a
        // passive (non-resuming) synthetic note when available so the model has
        // accurate context on the next turn without forcing an unwanted wakeup.
        if (cancelSource === "tui") {
          job.resultDelivered = true;
          if (ctx.session?.synthetic) {
            const text = [
              `[Background \`agy\` job cancelled by user]`,
              `- job_id: ${job.id}`,
              ...(job.agySessionId ? [`- agy_session_id: ${job.agySessionId}`] : []),
              `- prompt: ${truncateOneLine(job.prompt, 160)}`,
            ].join("\n");
            await ctx.session
              .synthetic({
                sessionID: job.openCodeSessionId,
                text,
                delivery: "queue",
                resume: false,
              })
              .catch(() => {});
          }
          return;
        }

        const header = [
          `[Background \`agy\` job ${job.status === "completed" ? "completed" : "failed"}]`,
          `- job_id: ${job.id}`,
          ...(job.agySessionId ? [`- agy_session_id: ${job.agySessionId}`] : []),
          ...(job.model ? [`- model: ${job.model}`] : []),
          `- duration: ${formatElapsedSeconds(job.startedAt, job.completedAt)}`,
          `- prompt: ${truncateOneLine(job.prompt, 160)}`,
          "",
          job.result?.content ?? `(no output)`,
        ].join("\n");

        if (ctx.session?.synthetic) {
          job.resultDelivered = true;
          try {
            await ctx.session.synthetic({
              sessionID: job.openCodeSessionId,
              text: header,
              delivery: "queue",
              resume: true,
            });
          } catch {
            job.resultDelivered = false;
          }
          return;
        }

        if (ctx.session?.prompt) {
          job.resultDelivered = true;
          try {
            await ctx.session.prompt({
              sessionID: job.openCodeSessionId,
              text: header,
              delivery: "queue",
            });
          } catch {
            job.resultDelivered = false;
          }
        }
      };

      const registration = await ctx.tool.transform((tools) => {
        tools.add({
          name: "agy",
          description: [
            "Delegate a coding, analysis, or verification task to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol. Reuses your authenticated `agy` CLI login and bridges `agy` permission requests through OpenCode's native permission rules. Load the `opencode-agy-acp` skill for full model-tier, backgrounding, and error-recovery guidance.",
            "",
            "Usage guidelines:",
            "- Only invoke this tool when the user explicitly requests using `agy` / Antigravity (or runs `/agy`). Do not call it proactively without an explicit user request.",
            "- `agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Delegate cohesive, goal-oriented tasks with exact file paths and constraints rather than pasting large files.",
            "- Explicitly state whether the task is read-only analysis or allowed to edit files/run commands, and start `prompt` with a normal word (never a leading `/`, which triggers `agy` slash-command expansion).",
            "- Nothing `agy` produces is verified: ask `agy` to wait for any subagents and report changed files/verification in its final reply, then inspect diffs and run tests yourself.",
            "- Sessions are explicit: omit `session_id` to start a fresh `agy` session; pass `session_id` (from a prior result's `[agy_session_id: ...]` or `metadata.agySessionId`) to continue that specific session. Multiple `agy` calls can run concurrently.",
            "- Foreground vs. background: by default, calls wait for `agy` to finish (default 15m timeout). Pass `background: true` to detach immediately (or `wait_ms` to wait briefly and auto-background if still running); OpenCode is notified automatically when the background job finishes, so never busy-poll `agy_job`.",
          ].join("\n"),
          input: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The task or question to send to Antigravity (`agy`). Start with a normal word (not `/`).",
              },
              session_id: {
                type: "string",
                description:
                  "Optional `agy` ACP session ID to continue (e.g., from a prior result's `[agy_session_id: ...]` or `metadata.agySessionId`). Omit to always start a fresh `agy` session.",
              },
              cwd: {
                type: "string",
                description:
                  "Optional working directory for the `agy` session (defaults to the current workspace directory).",
              },
              model: {
                type: "string",
                description:
                  "Optional model ID to select via ACP `session/set_model` before prompting. Only use `gemini-4` and `claude-5-5` models, preferring Gemini 4 by default: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}` (hydrogen = fast everyday workhorse, neon = Opus-class flagship that beats Opus 5.5 on most benchmarks) and `gemini-4-argon-{low|medium|high}` (Fable-class frontier reasoning); secondary cross-model options: `claude-{opus|sonnet}-5-5-{low|medium|high}`.",
              },
              timeout_ms: {
                type: "number",
                description:
                  "Optional turn timeout in milliseconds (default 900000 = 15 minutes; min 1000, max 14400000).",
              },
              background: {
                type: "boolean",
                description:
                  "Optional. Set `true` to run this `agy` call in the background: starts/loads the ACP session, returns `job_id` + `agy_session_id` immediately, and wakes the OpenCode session automatically when `agy` finishes.",
              },
              wait_ms: {
                type: "number",
                description:
                  "Optional foreground wait threshold in milliseconds. Waits up to `wait_ms` for `agy` to finish synchronously; if still running, moves the call to the background automatically and returns `job_id` + `agy_session_id`.",
              },
            },
            required: ["prompt"],
            additionalProperties: false,
          },
          execute: async (rawInput, toolCtx) => {
            const input = (rawInput ?? {}) as AgyToolInput;
            const prompt =
              typeof input.prompt === "string" ? input.prompt.trim() : "";
            if (!prompt) {
              return formatAgyErrorResult(
                new Error(
                  "AGY_INVALID_ARGUMENT: agy tool requires a non-empty `prompt` string.",
                ),
              );
            }

            const cwd =
              typeof input.cwd === "string" && input.cwd.trim() !== ""
                ? input.cwd.trim()
                : defaultCwd;
            const timeoutMs = clampTimeout(input.timeout_ms);
            const waitMs = normalizeWaitMs(input.wait_ms);
            const requestedSessionId = nonEmptyString(input.session_id);
            const requestedModel = nonEmptyString(input.model);
            const startedAt = Date.now();

            const candidateId = nonEmptyString(toolCtx.id);
            const runId =
              candidateId && !usedRunIds.has(candidateId)
                ? candidateId
                : `agy-${startedAt}-${++runSeq}`;
            usedRunIds.add(runId);

            const client = new AcpClient({
              binary: pluginOptions.binary,
              args: pluginOptions.args,
              cwd,
              spawn: pluginOptions.spawn,
              env: pluginOptions.env,
            });

            const acc: TurnAccumulator = {
              text: "",
              thoughts: "",
              plan: [],
              toolCalls: new Map(),
            };

            let agySessionId = requestedSessionId;
            let isBackground = Boolean(input.background);
            let cancelSource: CancelSource | undefined;
            const jobAbortController = new AbortController();

            const onForegroundSignalAbort = () => {
              if (isBackground) return;
              cancelSource = "opencode";
              jobAbortController.abort();
            };

            if (!isBackground && toolCtx.signal) {
              if (toolCtx.signal.aborted) {
                cancelSource = "opencode";
                jobAbortController.abort();
              } else {
                toolCtx.signal.addEventListener("abort", onForegroundSignalAbort, {
                  once: true,
                });
              }
            }

            const detachForegroundSignal = () => {
              toolCtx.signal?.removeEventListener(
                "abort",
                onForegroundSignalAbort,
              );
            };

            const currentActivity = (): string => {
              const calls = Array.from(acc.toolCalls.values());
              for (let i = calls.length - 1; i >= 0; i--) {
                const call = calls[i];
                const st = (call?.status ?? "").toLowerCase();
                if (
                  call &&
                  st !== "completed" &&
                  st !== "done" &&
                  st !== "failed" &&
                  st !== "error" &&
                  st !== "cancelled"
                ) {
                  return call.detail
                    ? `${call.title} — ${call.detail}`
                    : call.title;
                }
              }
              if (acc.text.trim() !== "") return "Responding…";
              if (acc.thoughts.trim() !== "") return "Thinking…";
              return "Starting…";
            };

            let lastProgressAt = 0;
            const buildTraceRun = (
              status: AgyTraceRun["status"],
              extra: { completedAt?: number; errorMessage?: string } = {},
            ): AgyTraceRun => {
              const calls = Array.from(acc.toolCalls.values());
              return {
                id: runId,
                status,
                ...(isBackground ? { background: true } : {}),
                prompt,
                ...(agySessionId ? { agySessionId } : {}),
                ...(requestedModel ? { model: requestedModel } : {}),
                cwd,
                startedAt,
                ...(extra.completedAt !== undefined
                  ? { completedAt: extra.completedAt }
                  : {}),
                updatedAt: Date.now(),
                currentActivity: currentActivity(),
                toolCallCount: calls.length,
                toolCalls: calls.slice(-200),
                plan: acc.plan.slice(0, 20),
                latestThought: lastNonEmptyLine(acc.thoughts, 200),
                latestText: lastNonEmptyLine(acc.text, 200),
                charsReceived: acc.text.length,
                ...(extra.errorMessage
                  ? { errorMessage: extra.errorMessage }
                  : {}),
              };
            };

            const emitProgress = async (force = false) => {
              const now = Date.now();
              if (!force && now - lastProgressAt < 150) return;
              lastProgressAt = now;
              const run = buildTraceRun("running");
              recordTrace(toolCtx.sessionID, run);
              if (isBackground || !toolCtx.progress) return;
              const calls = Array.from(acc.toolCalls.values());
              await toolCtx
                .progress({
                  status: "running",
                  ...(agySessionId ? { agySessionId } : {}),
                  startedAt,
                  ...(requestedModel ? { model: requestedModel } : {}),
                  currentActivity: run.currentActivity,
                  toolCallCount: calls.length,
                  toolCalls: run.toolCalls,
                  recentTools: calls
                    .slice(-5)
                    .map(
                      (t) =>
                        `${t.title}${t.detail ? ` (${t.detail})` : ""}${t.status ? ` [${t.status}]` : ""}`,
                    ),
                  plan: run.plan,
                  latestThought: run.latestThought,
                  latestText: run.latestText,
                  charsReceived: acc.text.length,
                })
                .catch(() => {});
            };

            recordTrace(toolCtx.sessionID, buildTraceRun("running"));

            let modelWarning: string | undefined;
            try {
              if (jobAbortController.signal.aborted) {
                throw new Error(
                  `AGY_ACP_CANCELLED: prompt aborted by OpenCode${agySessionId ? ` (session_id=${agySessionId})` : ""}`,
                );
              }

              await client.ensureStarted();

              if (requestedSessionId) {
                try {
                  await client.loadSession(requestedSessionId, cwd);
                  agySessionId = requestedSessionId;
                } catch (err) {
                  const detail =
                    err instanceof Error ? err.message : String(err);
                  throw new Error(
                    `AGY_SESSION_LOAD_FAILED: Could not load agy session "${requestedSessionId}": ${detail}`,
                  );
                }
              } else {
                agySessionId = await client.newSession(cwd);
              }

              if (requestedModel) {
                try {
                  await client.setModel(agySessionId, requestedModel);
                } catch (err) {
                  modelWarning =
                    err instanceof Error ? err.message : String(err);
                }
              }
            } catch (startupError) {
              detachForegroundSignal();
              const msg =
                startupError instanceof Error
                  ? startupError.message
                  : String(startupError);
              recordTrace(
                toolCtx.sessionID,
                buildTraceRun(
                  msg.startsWith("AGY_ACP_CANCELLED:") ? "cancelled" : "error",
                  {
                    completedAt: Date.now(),
                    errorMessage: msg,
                  },
                ),
              );
              await client.close().catch(() => {});
              if (msg.startsWith("AGY_ACP_CANCELLED:")) {
                throw startupError;
              }
              return formatAgyErrorResult(startupError, {
                agySessionId,
                timeoutMs,
                maxTimeoutMs: MAX_TIMEOUT_MS,
                stderrTail: client.stderrTail,
              });
            }

            let resolveSettled!: () => void;
            const settled = new Promise<void>((resolve) => {
              resolveSettled = resolve;
            });

            let resolveDetachTrigger:
              | ((reason: "wait_ms" | "tui") => void)
              | undefined;
            const detachTriggerPromise = new Promise<"wait_ms" | "tui">(
              (resolve) => {
                resolveDetachTrigger = resolve;
              },
            );

            const jobRecord: AgyJobRecord = {
              id: runId,
              openCodeSessionId: toolCtx.sessionID,
              prompt,
              cwd,
              model: requestedModel,
              startedAt,
              agySessionId,
              background: isBackground,
              status: "running",
              resultDelivered: false,
              snapshot: () =>
                buildTraceRun(jobRecord.status, {
                  completedAt: jobRecord.completedAt,
                }),
              moveToBackground: (reason) => {
                if (jobRecord.status !== "running") return false;
                const changed = !isBackground;
                isBackground = true;
                jobRecord.background = true;
                detachForegroundSignal();
                recordTrace(toolCtx.sessionID, buildTraceRun("running"));
                if (changed && (reason === "wait_ms" || reason === "tui")) {
                  resolveDetachTrigger?.(reason);
                }
                return true;
              },
              cancel: (source) => {
                if (jobRecord.status !== "running") return;
                if (!cancelSource) cancelSource = source;
                jobAbortController.abort();
              },
              settled,
              waiters: new Set(),
            };

            const sessionIdForTurn = agySessionId!;
            activeRuns.set(runId, jobRecord);
            getSessionJobMap(toolCtx.sessionID).set(runId, jobRecord);
            ensureControlLoop();

            client.setTurnHandlers({
              onUpdate: async (params) => {
                const updateSessionId =
                  typeof params.sessionId === "string"
                    ? params.sessionId
                    : undefined;
                if (updateSessionId && updateSessionId !== sessionIdForTurn) {
                  return;
                }
                const structural = applySessionUpdate(acc, params);
                await emitProgress(structural);
              },
              onPermissionRequest: async (params) => {
                return await handleAcpPermissionRequest(params, {
                  sessionID: toolCtx.sessionID,
                  agent: toolCtx.agent,
                  // Once detached into the background, omit the completed tool
                  // part reference so OpenCode prompts at the session level.
                  messageID: isBackground ? undefined : toolCtx.messageID,
                  toolCallID: isBackground ? undefined : toolCtx.id,
                  signal: jobAbortController.signal,
                  assertPermission: (req) => ctx.permission.assert(req),
                });
              },
            });

            await emitProgress(true);

            const runPromptTurn = async (): Promise<void> => {
              try {
                const res = await client.prompt(sessionIdForTurn, prompt, {
                  signal: jobAbortController.signal,
                  timeoutMs,
                });

                const toolCalls = Array.from(acc.toolCalls.values());
                const body = acc.text.trim()
                  ? truncateTail(acc.text.trim(), MAX_OUTPUT_CHARS)
                  : `(agy completed with stopReason="${res.stopReason}" and no text output)`;

                const prefix = modelWarning
                  ? `[Note: model override failed: ${modelWarning}]\n\n`
                  : "";
                const content = `${prefix}${body}\n\n[agy_session_id: ${sessionIdForTurn}]`;

                const usage = asRecord(res.raw.usage);
                const completedAt = Date.now();

                jobRecord.status = "completed";
                jobRecord.completedAt = completedAt;
                jobRecord.result = {
                  content,
                  metadata: {
                    jobId: runId,
                    ...(isBackground ? { background: true } : {}),
                    agySessionId: sessionIdForTurn,
                    startedAt,
                    completedAt,
                    ...(requestedModel ? { model: requestedModel } : {}),
                    stopReason: res.stopReason,
                    toolCallCount: toolCalls.length,
                    toolCalls,
                    ...(acc.plan.length > 0 ? { plan: acc.plan } : {}),
                    ...(usage ? { usage } : {}),
                    ...(modelWarning ? { modelWarning } : {}),
                  },
                };

                recordTrace(
                  toolCtx.sessionID,
                  buildTraceRun("completed", { completedAt }),
                );
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
                const completedAt = Date.now();
                const isCancelled =
                  msg.startsWith("AGY_ACP_CANCELLED:") ||
                  cancelSource !== undefined;

                if (isCancelled) {
                  jobRecord.status = "cancelled";
                  jobRecord.completedAt = completedAt;
                  if (cancelSource === "opencode" && !isBackground) {
                    jobRecord.rethrowError = error;
                  }
                  const partial = acc.text.trim()
                    ? `\n\nPartial output before cancellation:\n${truncateTail(acc.text.trim(), 8_000)}`
                    : "";
                  jobRecord.result = {
                    content: `AGY_CANCELLED: \`agy\` job "${runId}" was cancelled (${cancelSource ?? "aborted"}).${partial}\n\n[agy_job_id: ${runId}]\n[agy_session_id: ${sessionIdForTurn}]`,
                    metadata: {
                      cancelled: true,
                      cancelSource: cancelSource ?? "aborted",
                      jobId: runId,
                      ...(isBackground ? { background: true } : {}),
                      agySessionId: sessionIdForTurn,
                      startedAt,
                      completedAt,
                      toolCallCount: acc.toolCalls.size,
                      toolCalls: Array.from(acc.toolCalls.values()),
                    },
                  };
                  recordTrace(
                    toolCtx.sessionID,
                    buildTraceRun("cancelled", { completedAt }),
                  );
                } else {
                  jobRecord.status = "error";
                  jobRecord.completedAt = completedAt;
                  const errRes = formatAgyErrorResult(error, {
                    agySessionId: sessionIdForTurn,
                    timeoutMs,
                    maxTimeoutMs: MAX_TIMEOUT_MS,
                    partialOutput: acc.text.trim()
                      ? truncateTail(acc.text.trim(), 8_000)
                      : undefined,
                    stderrTail: client.stderrTail,
                    toolCalls: Array.from(acc.toolCalls.values()),
                  });
                  jobRecord.result = {
                    content: errRes.content,
                    metadata: {
                      ...errRes.metadata,
                      jobId: runId,
                      ...(isBackground ? { background: true } : {}),
                    },
                  };
                  recordTrace(
                    toolCtx.sessionID,
                    buildTraceRun("error", {
                      completedAt,
                      errorMessage: msg,
                    }),
                  );
                }
              } finally {
                detachForegroundSignal();
                client.setTurnHandlers({});
                await client.close().catch(() => {});
                activeRuns.delete(runId);
                pruneSettledJobs(toolCtx.sessionID);
                if (activeRuns.size === 0 && controlTimer !== undefined) {
                  clearInterval(controlTimer);
                  controlTimer = undefined;
                }

                await notifyBackgroundCompletion(jobRecord, cancelSource);
                resolveSettled();
                for (const wake of jobRecord.waiters) {
                  wake();
                }
                jobRecord.waiters.clear();
              }
            };

            const turnPromise = runPromptTurn();

            if (isBackground) {
              jobRecord.moveToBackground("input");
              return formatDetachedLaunchResult(
                jobRecord,
                "input",
                modelWarning,
              );
            }

            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            if (waitMs !== undefined) {
              waitTimer = setTimeout(() => {
                jobRecord.moveToBackground("wait_ms");
              }, waitMs);
            }

            try {
              const raceOutcome = await Promise.race([
                turnPromise.then(() => ({ kind: "settled" as const })),
                detachTriggerPromise.then((reason) => ({
                  kind: "detached" as const,
                  reason,
                })),
              ]);

              if (raceOutcome.kind === "detached") {
                return formatDetachedLaunchResult(
                  jobRecord,
                  raceOutcome.reason,
                  modelWarning,
                );
              }

              // Foreground completion: mark delivered so nothing else treats it
              // as an uncollected background job.
              jobRecord.resultDelivered = true;
              if (jobRecord.rethrowError !== undefined) {
                throw jobRecord.rethrowError;
              }
              return (
                jobRecord.result ?? {
                  content: `(agy job ${runId} finished with no result)`,
                }
              );
            } finally {
              if (waitTimer !== undefined) clearTimeout(waitTimer);
            }
          },
        });

        tools.add({
          name: "agy_job",
          description: [
            "Inspect, wait on, or cancel background `agy` tool calls in the current OpenCode session.",
            "",
            "Usage guidelines:",
            "- Background `agy` runs automatically wake the OpenCode session with their full output when they finish. Do NOT poll `agy_job` in a loop.",
            "- Use `action: \"list\"` to view active and recent `agy` jobs in this session.",
            "- Use `action: \"status\"` with `job_id` for a non-blocking snapshot (or to retrieve an already-completed job's result).",
            "- Use `action: \"wait\"` (with optional `job_id` and `timeout_ms`) only when you explicitly need to block until a background `agy` run finishes before taking your next step.",
            "- Use `action: \"cancel\"` with `job_id` (or `job_id: \"all\"`) to gracefully stop a running `agy` job via ACP `session/cancel`.",
          ].join("\n"),
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["list", "status", "wait", "cancel"],
                description:
                  "Operation to perform: `list` jobs in this session, check non-blocking `status`, `wait` for completion, or `cancel` a running job.",
              },
              job_id: {
                type: "string",
                description:
                  "Target `agy` job ID (from `[agy_job_id: ...]` or `metadata.jobId`). Optional for `list` and `wait`; required for `cancel` (pass `\"all\"` to cancel all running jobs in this session).",
              },
              timeout_ms: {
                type: "number",
                description:
                  "Optional max wait duration in milliseconds when `action` is `\"wait\"` (default 900000 = 15 minutes). Exceeding `timeout_ms` returns current status without cancelling the background job.",
              },
            },
            required: ["action"],
            additionalProperties: false,
          },
          execute: async (rawInput, toolCtx) => {
            const input = (rawInput ?? {}) as AgyJobToolInput;
            const action = input.action;
            if (
              action !== "list" &&
              action !== "status" &&
              action !== "wait" &&
              action !== "cancel"
            ) {
              return formatAgyErrorResult(
                new Error(
                  'AGY_INVALID_ARGUMENT: agy_job requires `action` to be one of "list", "status", "wait", or "cancel".',
                ),
              );
            }

            const sessionJobs = Array.from(
              getSessionJobMap(toolCtx.sessionID).values(),
            );
            const requestedJobId = nonEmptyString(input.job_id);

            if (action === "list") {
              if (sessionJobs.length === 0) {
                return {
                  content: "No `agy` jobs recorded in this session.",
                  metadata: { jobs: [] },
                };
              }

              const ordered = [...sessionJobs].reverse();
              const lines = [
                `\`agy\` jobs in this session (${ordered.length}):`,
                ...ordered.map((j) => {
                  const snap = j.snapshot();
                  const mode = j.background ? "bg" : "fg";
                  const dur = formatElapsedSeconds(j.startedAt, j.completedAt);
                  const sid = j.agySessionId ? ` · session=${j.agySessionId}` : "";
                  const steps =
                    snap.toolCallCount > 0
                      ? ` · ${snap.toolCallCount} ${snap.toolCallCount === 1 ? "step" : "steps"}`
                      : "";
                  const activity =
                    j.status === "running" && snap.currentActivity
                      ? ` · ${snap.currentActivity}`
                      : "";
                  return `- ${j.id} [${j.status} · ${mode} · ${dur}${steps}${activity}${sid}] — ${truncateOneLine(j.prompt, 100)}`;
                }),
              ];

              return {
                content: lines.join("\n"),
                metadata: {
                  jobs: ordered.map((j) => {
                    const snap = j.snapshot();
                    return {
                      jobId: j.id,
                      status: j.status,
                      background: j.background,
                      agySessionId: j.agySessionId,
                      model: j.model,
                      startedAt: j.startedAt,
                      completedAt: j.completedAt,
                      toolCallCount: snap.toolCallCount,
                      currentActivity: snap.currentActivity,
                      prompt: truncateOneLine(j.prompt, 160),
                    };
                  }),
                },
              };
            }

            if (action === "status") {
              const target = requestedJobId
                ? getSessionJobMap(toolCtx.sessionID).get(requestedJobId)
                : sessionJobs.length === 1
                  ? sessionJobs[0]
                  : undefined;

              if (!target) {
                return formatAgyErrorResult(
                  new Error(
                    requestedJobId
                      ? `AGY_INVALID_ARGUMENT: Unknown agy job_id "${requestedJobId}" in this session.`
                      : 'AGY_INVALID_ARGUMENT: Pass `job_id` to `agy_job` with `action: "status"` (or use `action: "list"`).',
                  ),
                );
              }
              return formatJobStatusResult(target);
            }

            if (action === "cancel") {
              if (!requestedJobId) {
                return formatAgyErrorResult(
                  new Error(
                    'AGY_INVALID_ARGUMENT: `agy_job` with `action: "cancel"` requires `job_id` (or `"all"`).',
                  ),
                );
              }

              const targets =
                requestedJobId === "all"
                  ? sessionJobs.filter((j) => j.status === "running")
                  : (() => {
                      const single = getSessionJobMap(toolCtx.sessionID).get(
                        requestedJobId,
                      );
                      return single ? [single] : [];
                    })();

              if (targets.length === 0) {
                if (requestedJobId === "all") {
                  return {
                    content: "No running `agy` jobs to cancel in this session.",
                    metadata: { cancelledJobIds: [] },
                  };
                }
                return formatAgyErrorResult(
                  new Error(
                    `AGY_INVALID_ARGUMENT: Unknown agy job_id "${requestedJobId}" in this session.`,
                  ),
                );
              }

              const runningTargets = targets.filter((j) => j.status === "running");
              if (runningTargets.length === 0) {
                const single = targets[0]!;
                return {
                  content: `\`agy\` job "${single.id}" is already ${single.status}.`,
                  metadata: {
                    jobId: single.id,
                    status: single.status,
                    agySessionId: single.agySessionId,
                    cancelledJobIds: [],
                  },
                };
              }

              for (const job of runningTargets) {
                job.cancel("job_tool");
              }

              await Promise.race([
                Promise.allSettled(runningTargets.map((j) => j.settled)),
                new Promise((resolve) => setTimeout(resolve, 5_000)),
              ]);

              const cancelledIds = runningTargets.map((j) => j.id);
              const details = runningTargets.map(
                (j) =>
                  `- ${j.id}${j.agySessionId ? ` [agy_session_id: ${j.agySessionId}]` : ""}`,
              );
              return {
                content: [
                  `Cancelled ${cancelledIds.length} \`agy\` ${cancelledIds.length === 1 ? "job" : "jobs"}:`,
                  ...details,
                ].join("\n"),
                metadata: {
                  cancelledJobIds: cancelledIds,
                  jobs: runningTargets.map((j) => ({
                    jobId: j.id,
                    status: j.status,
                    agySessionId: j.agySessionId,
                  })),
                },
              };
            }

            // action === "wait"
            let candidates: AgyJobRecord[] = [];
            if (requestedJobId) {
              const found = getSessionJobMap(toolCtx.sessionID).get(
                requestedJobId,
              );
              if (!found) {
                return formatAgyErrorResult(
                  new Error(
                    `AGY_INVALID_ARGUMENT: Unknown agy job_id "${requestedJobId}" in this session.`,
                  ),
                );
              }
              if (found.status !== "running") {
                return formatJobStatusResult(found);
              }
              candidates = [found];
            } else {
              const uncollected = sessionJobs.find(
                (j) => j.background && j.status !== "running" && !j.resultDelivered,
              );
              if (uncollected) {
                return formatJobStatusResult(uncollected);
              }
              candidates = sessionJobs.filter((j) => j.status === "running");
              if (candidates.length === 0) {
                return {
                  content: "No running background `agy` jobs to wait on in this session.",
                  metadata: { status: "idle", jobs: [] },
                };
              }
            }

            const waitTimeoutMs = clampTimeout(input.timeout_ms);
            if (toolCtx.signal?.aborted) {
              throw new Error("AGY_WAIT_ABORTED: agy_job wait aborted by OpenCode");
            }

            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            const cleanups: Array<() => void> = [];

            try {
              const outcome = await new Promise<
                | { kind: "settled"; job: AgyJobRecord }
                | { kind: "timeout" }
                | { kind: "aborted" }
              >((resolve) => {
                for (const candidate of candidates) {
                  if (candidate.status !== "running") {
                    resolve({ kind: "settled", job: candidate });
                    return;
                  }
                  const onWake = () => {
                    resolve({ kind: "settled", job: candidate });
                  };
                  candidate.waiters.add(onWake);
                  cleanups.push(() => candidate.waiters.delete(onWake));
                }

                waitTimer = setTimeout(() => {
                  resolve({ kind: "timeout" });
                }, waitTimeoutMs);

                if (toolCtx.signal) {
                  const onAbort = () => resolve({ kind: "aborted" });
                  toolCtx.signal.addEventListener("abort", onAbort, {
                    once: true,
                  });
                  cleanups.push(() =>
                    toolCtx.signal?.removeEventListener("abort", onAbort),
                  );
                }
              });

              if (outcome.kind === "aborted") {
                throw new Error(
                  "AGY_WAIT_ABORTED: agy_job wait aborted by OpenCode",
                );
              }

              if (outcome.kind === "timeout") {
                const primary = candidates[0]!;
                const statusRes = formatJobStatusResult(primary);
                return {
                  content: `Wait timeout (${waitTimeoutMs}ms) reached — \`agy\` job is still running in the background.\n\n${statusRes.content ?? ""}`,
                  metadata: {
                    ...(statusRes.metadata ?? {}),
                    timedOutWaiting: true,
                  },
                };
              }

              return formatJobStatusResult(outcome.job);
            } finally {
              if (waitTimer !== undefined) clearTimeout(waitTimer);
              for (const fn of cleanups) fn();
            }
          },
        });
      });

      const disposables: Array<{ dispose(): Promise<void> | void }> = [
        registration,
      ];

      if (ctx.command?.transform && ctx.session?.prompt) {
        try {
          const parsedCommand = parseFrontmatterMarkdown(
            readFileSync(COMMAND_FILE_PATH, "utf8"),
          );
          const promptFn = ctx.session.prompt.bind(ctx.session);
          const commandReg = await ctx.command.transform((commands) => {
            commands.add({
              name: "agy",
              description:
                parsedCommand.frontmatter.description ||
                "Delegate a task to Google Antigravity (`agy acp`)",
              execute: async (invocation) => {
                await promptFn({
                  sessionID: invocation.sessionID,
                  text: buildAgyCommandPrompt(
                    parsedCommand.body,
                    invocation.prompt.text,
                  ),
                  ...(invocation.prompt.files
                    ? { files: invocation.prompt.files }
                    : {}),
                  ...(invocation.delivery !== undefined
                    ? { delivery: invocation.delivery }
                    : {}),
                });
              },
            });
          });
          disposables.push(commandReg);
        } catch (err) {
          console.warn(
            "[opencode-agy-acp] /agy command registration skipped:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (ctx.skill?.transform) {
        try {
          const parsedSkill = parseFrontmatterMarkdown(
            readFileSync(SKILL_FILE_PATH, "utf8"),
          );
          const skillDescription = parsedSkill.frontmatter.description;
          const skillBody = parsedSkill.body;
          const skillReg = await ctx.skill.transform((skills) => {
            const existing = skills.get?.(SKILL_ID);
            if (!existing) {
              skills.add({
                id: SKILL_ID,
                name: SKILL_NAME,
                description: skillDescription,
                path: SKILL_FILE_PATH,
                content: skillBody,
              });
            } else if (
              skills.update &&
              (existing.content !== skillBody ||
                existing.description !== skillDescription ||
                existing.name !== SKILL_NAME ||
                existing.path !== SKILL_FILE_PATH)
            ) {
              skills.update(SKILL_ID, (s) => {
                s.name = SKILL_NAME;
                s.description = skillDescription;
                s.path = SKILL_FILE_PATH;
                s.content = skillBody;
              });
            }
          });
          disposables.push(skillReg);
        } catch (err) {
          console.warn(
            "[opencode-agy-acp] skill registration skipped:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Only unregister tool/command/skill definitions on reload/dispose; let
      // any in-flight foreground or background runs finish and close their own
      // AcpClient + control loop in `finally` so hot-reloading the plugin never
      // kills running `agy` turns mid-flight.
      return async () => {
        if (activeRuns.size === 0 && controlTimer !== undefined) {
          clearInterval(controlTimer);
          controlTimer = undefined;
        }
        for (const item of disposables) {
          await item.dispose();
        }
      };
    },
  };
}

export default createAgyAcpPlugin();
