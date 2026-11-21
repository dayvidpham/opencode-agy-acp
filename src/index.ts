// OpenCode 2.0 plugin that drives Google Antigravity CLI (`agy acp`) over
// the Agent Client Protocol (ACP) with native OpenCode permission bridging.
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
  readSessionTraces,
  writeSessionTraces,
  type AgyTraceRun,
} from "./trace.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_OUTPUT_CHARS = 120_000;

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
  const replacement = trimmed || "(No task provided — ask the user what they want delegated to `agy`.)";
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
          ) => Promise<{
            readonly content?: string;
            readonly metadata?: Readonly<Record<string, unknown>>;
          }>;
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
    readonly prompt: (input: {
      readonly sessionID: string;
      readonly text: string;
      readonly files?: readonly unknown[];
      readonly delivery?: "steer" | "queue" | null;
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
      const detail = rawDetail && rawDetail !== title ? rawDetail : undefined;
      acc.toolCalls.set(id, {
        id,
        title,
        kind:
          typeof update.kind === "string" ? update.kind : prev?.kind,
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

function truncateTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `[...${omitted} chars truncated...]\n` + text.slice(-limit);
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
      // even when OpenCode Code Mode (`execute`) replaces `toolCtx.progress`
      // with a no-op.
      const sessionTraces = new Map<string, Map<string, AgyTraceRun>>();
      let runSeq = 0;

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

      const registration = await ctx.tool.transform((tools) => {
        tools.add({
          name: "agy",
          description: [
            "Delegate a coding, analysis, or verification task to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol. Reuses your authenticated `agy` CLI login and bridges `agy` permission requests through OpenCode's native permission rules. Load the `opencode-agy-acp` skill for full model-tier and error-recovery guidance.",
            "",
            "Usage guidelines:",
            "- Only invoke this tool when the user explicitly requests using `agy` / Antigravity (or runs `/agy`). Do not call it proactively without an explicit user request.",
            "- `agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Delegate cohesive, goal-oriented tasks with exact file paths and constraints rather than pasting large files.",
            "- Explicitly state whether the task is read-only analysis or allowed to edit files/run commands, and start `prompt` with a normal word (never a leading `/`, which triggers `agy` slash-command expansion).",
            "- Nothing `agy` produces is verified: ask `agy` to wait for any subagents and report changed files/verification in its final reply, then inspect diffs and run tests yourself.",
            "- Sessions are explicit: omit `session_id` to start a fresh `agy` session; pass `session_id` (from a prior result's `[agy_session_id: ...]` or `metadata.agySessionId`) to continue that specific session. Multiple `agy` calls can run concurrently.",
            "- Calls block until `agy` finishes the turn (default 15m timeout; on `AGY_ERROR [TIMEOUT]`, resume via `session_id` + `suggestedNextTimeoutMs`).",
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
                  "Optional timeout in milliseconds (default 900000 = 15 minutes; min 1000, max 14400000).",
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
            const requestedSessionId = nonEmptyString(input.session_id);
            const requestedModel = nonEmptyString(input.model);
            const startedAt = Date.now();
            const runId = nonEmptyString(toolCtx.id) ?? `agy-${startedAt}-${++runSeq}`;

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
              if (!toolCtx.progress) return;
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

            try {
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

              let modelWarning: string | undefined;
              if (requestedModel) {
                try {
                  await client.setModel(agySessionId, requestedModel);
                } catch (err) {
                  modelWarning =
                    err instanceof Error ? err.message : String(err);
                }
              }

              client.setTurnHandlers({
                onUpdate: async (params) => {
                  const updateSessionId =
                    typeof params.sessionId === "string"
                      ? params.sessionId
                      : undefined;
                  if (updateSessionId && updateSessionId !== agySessionId) {
                    return;
                  }
                  const structural = applySessionUpdate(acc, params);
                  await emitProgress(structural);
                },
                onPermissionRequest: async (params) => {
                  return await handleAcpPermissionRequest(params, {
                    sessionID: toolCtx.sessionID,
                    agent: toolCtx.agent,
                    messageID: toolCtx.messageID,
                    toolCallID: toolCtx.id,
                    signal: toolCtx.signal,
                    assertPermission: (req) => ctx.permission.assert(req),
                  });
                },
              });

              await emitProgress(true);

              const res = await client.prompt(agySessionId, prompt, {
                signal: toolCtx.signal,
                timeoutMs,
              });

              const toolCalls = Array.from(acc.toolCalls.values());
              const body = acc.text.trim()
                ? truncateTail(acc.text.trim(), MAX_OUTPUT_CHARS)
                : `(agy completed with stopReason="${res.stopReason}" and no text output)`;

              const prefix = modelWarning
                ? `[Note: model override failed: ${modelWarning}]\n\n`
                : "";
              const content = `${prefix}${body}\n\n[agy_session_id: ${agySessionId}]`;

              const usage = asRecord(res.raw.usage);
              const completedAt = Date.now();

              recordTrace(
                toolCtx.sessionID,
                buildTraceRun("completed", { completedAt }),
              );

              return {
                content,
                metadata: {
                  agySessionId,
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
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              recordTrace(
                toolCtx.sessionID,
                buildTraceRun("error", {
                  completedAt: Date.now(),
                  errorMessage: msg,
                }),
              );
              if (msg.startsWith("AGY_ACP_CANCELLED:")) {
                throw error;
              }
              return formatAgyErrorResult(error, {
                agySessionId,
                timeoutMs,
                maxTimeoutMs: MAX_TIMEOUT_MS,
                partialOutput: acc.text.trim()
                  ? truncateTail(acc.text.trim(), 8_000)
                  : undefined,
                stderrTail: client.stderrTail,
                toolCalls: Array.from(acc.toolCalls.values()),
              });
            } finally {
              client.setTurnHandlers({});
              await client.close().catch(() => {});
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
          const sessionApi = ctx.session;
          const commandReg = await ctx.command.transform((commands) => {
            commands.add({
              name: "agy",
              description:
                parsedCommand.frontmatter.description ||
                "Delegate a task to Google Antigravity (`agy acp`)",
              execute: async (invocation) => {
                await sessionApi.prompt({
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
      // any in-flight `execute()` calls finish and close their own AcpClient
      // in `finally` (or abort via `toolCtx.signal`) so hot-reloading the
      // plugin never kills running `agy` turns mid-flight.
      return async () => {
        for (const item of disposables) {
          await item.dispose();
        }
      };
    },
  };
}

export default createAgyAcpPlugin();
