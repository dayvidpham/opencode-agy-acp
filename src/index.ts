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
  readonly new_session?: boolean;
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
}

interface TurnAccumulator {
  text: string;
  thoughts: string;
  readonly toolCalls: Map<string, AgyToolCallSummary>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Extracts text chunks and tool call progress from ACP `session/update`
 * notifications. Handles both the ACP `params.update.sessionUpdate` envelope
 * and flat `ContentBlock[]` payloads.
 */
export function applySessionUpdate(
  acc: TurnAccumulator,
  params: Record<string, unknown>,
): void {
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
      return;
    }

    if (kind === "agent_thought_chunk") {
      const content = asRecord(update.content);
      if (content?.type === "text" && typeof content.text === "string") {
        acc.thoughts += content.text;
      } else if (typeof update.text === "string") {
        acc.thoughts += update.text;
      }
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      const id =
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : `tc-${acc.toolCalls.size + 1}`;
      const prev = acc.toolCalls.get(id);
      acc.toolCalls.set(id, {
        id,
        title:
          typeof update.title === "string" && update.title.trim() !== ""
            ? update.title
            : typeof update.name === "string" && update.name.trim() !== ""
              ? update.name
              : (prev?.title ?? "tool"),
        kind:
          typeof update.kind === "string" ? update.kind : prev?.kind,
        status:
          typeof update.status === "string" ? update.status : prev?.status,
      });
      return;
    }
  }

  // Fallback: flat ContentBlock[] format (as modeled in pasture/internal/acp)
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
        acc.toolCalls.set(id, {
          id,
          title: typeof block.name === "string" ? block.name : "tool",
          status: "running",
        });
      }
    }
  }
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
}

export function createAgyAcpPlugin(pluginOptions: CreatePluginOptions = {}) {
  return {
    id: "opencode-agy-acp",
    setup: async (ctx: OpenCodePluginContextLike) => {
      const defaultCwd = ctx?.location?.directory || process.cwd();
      const client = new AcpClient({
        binary: pluginOptions.binary,
        args: pluginOptions.args,
        cwd: defaultCwd,
        spawn: pluginOptions.spawn,
        env: pluginOptions.env,
      });

      // Maps OpenCode sessionID -> active agy ACP sessionId for warm follow-ups.
      const sessionMap = new Map<string, string>();
      // Tracks agy sessionIds already loaded in the current subprocess.
      const knownAgySessions = new Set<string>();
      // Serializes turns on the single stdio ACP subprocess so streamed updates
      // and permission prompts always correlate to the active OpenCode tool call.
      let turnQueue: Promise<void> = Promise.resolve();

      const registration = await ctx.tool.transform((tools) => {
        tools.add({
          name: "agy",
          description: [
            "Delegate a coding, analysis, or verification task to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol. Reuses your authenticated `agy` session and bridges `agy` permission requests through OpenCode's native permission rules. Load the `opencode-agy-acp` skill for full model-tier and error-recovery guidance.",
            "",
            "Usage guidelines:",
            "- Only invoke this tool when the user explicitly requests using `agy` / Antigravity (or runs `/agy`). Do not call it proactively without an explicit user request.",
            "- `agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Delegate cohesive, goal-oriented tasks with exact file paths and constraints rather than pasting large files.",
            "- Explicitly state whether the task is read-only analysis or allowed to edit files/run commands, and start `prompt` with a normal word (never a leading `/`, which triggers `agy` slash-command expansion).",
            "- Nothing `agy` produces is verified: ask `agy` to wait for any subagents and report changed files/verification in its final reply, then inspect diffs and run tests yourself.",
            "- Calls block until `agy` finishes the turn (default 15m timeout; on `AGY_ERROR [TIMEOUT]`, resume via `session_id` + `suggestedNextTimeoutMs`). Omit `session_id`/`new_session` for warm follow-ups; pass `new_session: true` for unrelated tasks.",
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
                  "Optional `agy` ACP session ID to resume (e.g., from `metadata.agySessionId` after a timeout or across OpenCode sessions).",
              },
              new_session: {
                type: "boolean",
                description:
                  "If true, starts a fresh `agy` ACP session instead of reusing the one mapped to this OpenCode session. Use when switching to an unrelated task.",
              },
              cwd: {
                type: "string",
                description:
                  "Optional working directory for a new `agy` session (defaults to the current workspace directory).",
              },
              model: {
                type: "string",
                description:
                  "Optional model ID to select via ACP `session/set_model` before prompting. Only use `gemini-4` and `claude-5-5` families: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}` (hydrogen = fast everyday executor, neon = sweet-spot coding/agentic model) or `{gemini-4-argon|claude-opus-5-5|claude-sonnet-5-5}-{low|medium|high}` (argon = frontier reasoning/architecture, sonnet = careful review/edits, opus = hardest refactors/second opinions).",
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

            const runTurn = async () => {
              await client.ensureStarted();

              let agySessionId =
                typeof input.session_id === "string" &&
                input.session_id.trim() !== ""
                  ? input.session_id.trim()
                  : input.new_session
                    ? undefined
                    : sessionMap.get(toolCtx.sessionID);

              if (!agySessionId) {
                agySessionId = await client.newSession(cwd);
                knownAgySessions.add(agySessionId);
                sessionMap.set(toolCtx.sessionID, agySessionId);
              } else if (!knownAgySessions.has(agySessionId)) {
                try {
                  await client.loadSession(agySessionId, cwd);
                  knownAgySessions.add(agySessionId);
                } catch {
                  // If the agent does not support session/load or the old ID
                  // expired, start a fresh session and record it.
                  agySessionId = await client.newSession(cwd);
                  knownAgySessions.add(agySessionId);
                }
                sessionMap.set(toolCtx.sessionID, agySessionId);
              }

              let modelWarning: string | undefined;
              if (
                typeof input.model === "string" &&
                input.model.trim() !== ""
              ) {
                try {
                  await client.setModel(agySessionId, input.model.trim());
                } catch (err) {
                  modelWarning =
                    err instanceof Error ? err.message : String(err);
                }
              }

              const acc: TurnAccumulator = {
                text: "",
                thoughts: "",
                toolCalls: new Map(),
              };

              let lastProgressAt = 0;
              const emitProgress = async (force = false) => {
                if (!toolCtx.progress) return;
                const now = Date.now();
                if (!force && now - lastProgressAt < 250) return;
                lastProgressAt = now;
                await toolCtx
                  .progress({
                    status: "running",
                    agySessionId,
                    toolCallCount: acc.toolCalls.size,
                    recentTools: Array.from(acc.toolCalls.values())
                      .slice(-5)
                      .map((t) => `${t.title}${t.status ? ` (${t.status})` : ""}`),
                    charsReceived: acc.text.length,
                  })
                  .catch(() => {});
              };

              client.setTurnHandlers({
                onUpdate: async (params) => {
                  const updateSessionId =
                    typeof params.sessionId === "string"
                      ? params.sessionId
                      : undefined;
                  if (updateSessionId && updateSessionId !== agySessionId) {
                    return;
                  }
                  applySessionUpdate(acc, params);
                  await emitProgress(false);
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

              try {
                const res = await client.prompt(agySessionId, prompt, {
                  signal: toolCtx.signal,
                  timeoutMs,
                });

                const toolCalls = Array.from(acc.toolCalls.values());
                const body = acc.text.trim()
                  ? truncateTail(acc.text.trim(), MAX_OUTPUT_CHARS)
                  : `(agy completed with stopReason="${res.stopReason}" and no text output)`;

                const content = modelWarning
                  ? `[Note: model override failed: ${modelWarning}]\n\n${body}`
                  : body;

                const usage = asRecord(res.raw.usage);

                return {
                  content,
                  metadata: {
                    agySessionId,
                    stopReason: res.stopReason,
                    toolCalls,
                    ...(usage ? { usage } : {}),
                    ...(modelWarning ? { modelWarning } : {}),
                  },
                };
              } catch (error) {
                const msg =
                  error instanceof Error ? error.message : String(error);
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
              }
            };

            const previous = turnQueue;
            let releaseQueue!: () => void;
            turnQueue = new Promise<void>((resolve) => {
              releaseQueue = resolve;
            });

            await previous;
            try {
              return await runTurn();
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              if (msg.startsWith("AGY_ACP_CANCELLED:")) {
                throw error;
              }
              return formatAgyErrorResult(error, {
                timeoutMs,
                maxTimeoutMs: MAX_TIMEOUT_MS,
                stderrTail: client.stderrTail,
              });
            } finally {
              releaseQueue();
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

      return async () => {
        for (const item of disposables) {
          await item.dispose();
        }
        await client.close();
      };
    },
  };
}

export default createAgyAcpPlugin();
