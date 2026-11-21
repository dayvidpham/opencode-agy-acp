// OpenCode 2.0 plugin that drives Google Antigravity CLI (`agy acp`) over
// the Agent Client Protocol (ACP) with native OpenCode permission bridging.
//
// Zero runtime npm imports: runs directly on OpenCode's Bun runtime.

import { AcpClient, type AcpSpawner } from "./acp.ts";
import {
  handleAcpPermissionRequest,
  type OpenCodePermissionAssertInput,
} from "./permissions.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_OUTPUT_CHARS = 120_000;

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
            "Delegate a coding, analysis, or verification task to the local Google Antigravity CLI (`agy acp`) over the Agent Client Protocol. Reuses your authenticated `agy` session and bridges `agy` permission requests through OpenCode's native permission rules.",
            "",
            "Usage guidelines:",
            "- `agy` is a full autonomous coding agent with its own workspace read/search/edit/shell tools. Delegate cohesive, goal-oriented tasks with relevant file paths and constraints rather than pasting large files.",
            "- Explicitly state whether the task is read-only analysis or allowed to edit files/run commands.",
            "- Ask `agy` to wait for any subagents and include a concise final summary (changed files, verification run, remaining issues), since only its final text response is returned.",
            "- Calls block until `agy` finishes the turn (default 15m timeout; resumable via `session_id` on timeout). Omit `session_id`/`new_session` to continue the warm `agy` session for follow-ups; pass `new_session: true` when switching to an unrelated task.",
          ].join("\n"),
          input: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The task or question to send to Antigravity (`agy`).",
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
                  "Optional model ID to select via ACP `session/set_model` before prompting. Available IDs: `gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}`, `{gemini-4-argon|gemini-3.8-flash|claude-opus-5-5|claude-sonnet-5-5}-{low|medium|high}`, `gpt-oss-120b-medium`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator-g1-pro`.",
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
              throw new Error(
                "agy tool requires a non-empty `prompt` string.",
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
                if (msg.startsWith("AGY_ACP_TIMEOUT:")) {
                  const partial = acc.text.trim()
                    ? `\n\nPartial output so far:\n${truncateTail(acc.text.trim(), 8_000)}`
                    : "";
                  return {
                    content: `${msg}\nYou can resume this session by passing session_id="${agySessionId}".${partial}`,
                    metadata: {
                      agySessionId,
                      timedOut: true,
                      toolCalls: Array.from(acc.toolCalls.values()),
                    },
                  };
                }
                throw error;
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
            } finally {
              releaseQueue();
            }
          },
        });
      });

      return async () => {
        await registration.dispose();
        await client.close();
      };
    },
  };
}

export default createAgyAcpPlugin();
