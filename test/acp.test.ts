import { describe, expect, test } from "bun:test";
import {
  AcpClient,
  buildScrubbedEnv,
  type AcpProcessLike,
  type AcpSpawner,
} from "../src/acp.ts";
import {
  buildAgyCommandPrompt,
  createAgyAcpPlugin,
  parseFrontmatterMarkdown,
  type OpenCodeCommandInvocationLike,
  type OpenCodePluginContextLike,
} from "../src/index.ts";
import {
  classifyAgyError,
  formatAgyErrorResult,
  scrubSecrets,
} from "../src/errors.ts";
import type { OpenCodePermissionAssertInput } from "../src/permissions.ts";

interface MockAcpController {
  readonly spawner: AcpSpawner;
  readonly received: Array<Record<string, unknown>>;
  readonly spawnedEnv: () => Record<string, string> | undefined;
  send(msg: Record<string, unknown>): void;
  exit(code?: number): void;
}

function createMockAcpServer(
  onMessage: (
    msg: Record<string, unknown>,
    send: (reply: Record<string, unknown>) => void,
  ) => void | Promise<void>,
): MockAcpController {
  const received: Array<Record<string, unknown>> = [];
  let lastEnv: Record<string, string> | undefined;
  let lastSend: ((msg: Record<string, unknown>) => void) | undefined;
  let lastExit: ((code?: number) => void) | undefined;
  const encoder = new TextEncoder();

  const spawnOne = (): AcpProcessLike => {
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number) => void;
    let exitCode: number | null = null;

    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        stdoutController = c;
      },
    });

    const stderr = new ReadableStream<Uint8Array>({
      start(c) {
        stderrController = c;
      },
    });

    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const send = (msg: Record<string, unknown>) => {
      stdoutController.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
    };

    const exit = (code = 0) => {
      if (exitCode !== null) return;
      exitCode = code;
      try {
        stdoutController.close();
      } catch {}
      try {
        stderrController.close();
      } catch {}
      resolveExit(code);
    };

    lastSend = send;
    lastExit = exit;

    let stdinBuf = "";
    return {
      stdin: {
        write(chunk) {
          stdinBuf +=
            typeof chunk === "string"
              ? chunk
              : new TextDecoder().decode(chunk);
          let idx = stdinBuf.indexOf("\n");
          while (idx !== -1) {
            const line = stdinBuf.slice(0, idx).trim();
            stdinBuf = stdinBuf.slice(idx + 1);
            if (line) {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              received.push(parsed);
              void onMessage(parsed, send);
            }
            idx = stdinBuf.indexOf("\n");
          }
          return typeof chunk === "string" ? chunk.length : chunk.byteLength;
        },
        end() {
          exit(0);
        },
      },
      stdout,
      stderr,
      exited,
      get exitCode() {
        return exitCode;
      },
      kill() {
        exit(0);
      },
    };
  };

  return {
    spawner: (opts) => {
      lastEnv = opts.env;
      return spawnOne();
    },
    received,
    spawnedEnv: () => lastEnv,
    send: (msg) => lastSend?.(msg),
    exit: (code = 0) => lastExit?.(code),
  };
}

describe("buildScrubbedEnv", () => {
  test("keeps safe runtime vars and strips unrelated API keys", () => {
    const scrubbed = buildScrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      XDG_CONFIG_HOME: "/home/tester/.config",
      AGY_PROFILE: "default",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    });

    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/tester");
    expect(scrubbed.XDG_CONFIG_HOME).toBe("/home/tester/.config");
    expect(scrubbed.AGY_PROFILE).toBe("default");
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("opencode-agy-acp plugin", () => {
  test("runs initialize -> session/new -> session/prompt and bridges allow permission", async () => {
    const permissionAsserts: OpenCodePermissionAssertInput[] = [];
    let permissionReply: Record<string, unknown> | undefined;

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "agy-sess-1" },
        });
      } else if (msg.method === "session/prompt") {
        // Ask client for permission before finishing the prompt
        send({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: "agy-sess-1",
            toolCall: {
              toolCallId: "tc-1",
              title: "Edit src/app.ts",
              kind: "edit",
              locations: [{ path: "src/app.ts" }],
            },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        // Hold prompt id so we resolve once permission reply arrives
        pendingPromptId = msg.id as number;
      } else if (msg.id === 99 && msg.result) {
        permissionReply = msg;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "agy-sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Edited src/app.ts successfully." },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: pendingPromptId,
          result: { stopReason: "end_turn" },
        });
      }
    });
    let pendingPromptId = 0;

    let registeredExecute!: (
      input: unknown,
      ctx: {
        sessionID: string;
        agent?: string;
        messageID?: string;
        id?: string;
        signal?: AbortSignal;
        progress?: (update: Readonly<Record<string, unknown>>) => Promise<void>;
      },
    ) => Promise<{
      content?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: {
        assert: async (input) => {
          permissionAsserts.push(input);
        },
      },
      tool: {
        transform: async (fn) => {
          fn({
            add: (tool) => {
              registeredExecute = tool.execute;
            },
          });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);

    const progressEvents: Array<Readonly<Record<string, unknown>>> = [];
    const result = await registeredExecute(
      { prompt: "Update src/app.ts" },
      {
        sessionID: "oc-sess-1",
        agent: "build",
        messageID: "msg-1",
        id: "call-1",
        progress: async (u) => {
          progressEvents.push(u);
        },
      },
    );

    expect(result.content).toBe(
      "Edited src/app.ts successfully.\n\n[agy_session_id: agy-sess-1]",
    );
    expect(result.metadata?.agySessionId).toBe("agy-sess-1");
    expect(result.metadata?.stopReason).toBe("end_turn");
    expect(permissionAsserts.length).toBe(1);
    expect(permissionAsserts[0]?.action).toBe("edit");
    expect(permissionAsserts[0]?.resources).toEqual(["src/app.ts"]);
    expect(permissionReply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(progressEvents.length).toBeGreaterThan(0);

    await dispose();
  });

  test("maps OpenCode permission denial to ACP reject_once", async () => {
    let permissionReply: Record<string, unknown> | undefined;
    let pendingPromptId = 0;

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "agy-sess-deny" },
        });
      } else if (msg.method === "session/prompt") {
        pendingPromptId = msg.id as number;
        send({
          jsonrpc: "2.0",
          id: 55,
          method: "session/request_permission",
          params: {
            sessionId: "agy-sess-deny",
            toolCall: {
              toolCallId: "tc-rm",
              title: "Run rm -rf /tmp/foo",
              kind: "execute",
              rawInput: { command: "rm -rf /tmp/foo" },
            },
            options: [
              { optionId: "allow_once", kind: "allow_once" },
              { optionId: "reject_once", kind: "reject_once" },
            ],
          },
        });
      } else if (msg.id === 55 && msg.result) {
        permissionReply = msg;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "agy-sess-deny",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Skipped command after denial." },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: pendingPromptId,
          result: { stopReason: "end_turn" },
        });
      }
    });

    let registeredExecute!: (
      input: unknown,
      ctx: { sessionID: string },
    ) => Promise<{ content?: string }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: {
        assert: async () => {
          throw new Error("Permission denied by rule");
        },
      },
      tool: {
        transform: async (fn) => {
          fn({
            add: (tool) => {
              registeredExecute = tool.execute;
            },
          });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);
    const result = await registeredExecute(
      { prompt: "Clean /tmp/foo" },
      { sessionID: "oc-sess-2" },
    );

    expect(result.content).toBe(
      "Skipped command after denial.\n\n[agy_session_id: agy-sess-deny]",
    );
    expect(permissionReply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });

    await dispose();
  });

  test("replies -32601 to unknown server RPC requests so agent does not hang", async () => {
    let unknownReply: Record<string, unknown> | undefined;
    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
        send({
          jsonrpc: "2.0",
          id: 777,
          method: "fs/read_text_file",
          params: { path: "README.md" },
        });
      } else if (msg.id === 777) {
        unknownReply = msg;
      }
    });

    const client = new AcpClient({ spawn: mock.spawner });
    await client.ensureStarted();
    await new Promise((r) => setTimeout(r, 20));

    expect((unknownReply?.error as Record<string, unknown>)?.code).toBe(-32601);
    await client.close();
  });

  test("handles real agy acp 1.5.9 wire payloads (string id, allow/deny optionIds, args, usage)", async () => {
    const permissionAsserts: OpenCodePermissionAssertInput[] = [];
    let permissionReply: Record<string, unknown> | undefined;
    let pendingPromptId = 0;

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: "Antigravity ACP Server", version: "1.5.9" },
          },
        });
      } else if (msg.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId: "230f98dd-cc2e-419b-aefa-abc1d0677987",
            models: { currentModelId: "gemini-4-neon-high", availableModels: [] },
          },
        });
      } else if (msg.method === "session/prompt") {
        pendingPromptId = msg.id as number;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "230f98dd-cc2e-419b-aefa-abc1d0677987",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              name: "run_command",
              status: "pending",
              kind: "execute",
              title: "echo agy-probe-ok",
              args: { CommandLine: "echo agy-probe-ok", BypassSandbox: true },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: "1",
          method: "session/request_permission",
          params: {
            sessionId: "230f98dd-cc2e-419b-aefa-abc1d0677987",
            toolCall: {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              name: "run_command",
              args: { CommandLine: "echo agy-probe-ok", BypassSandbox: true },
              status: "pending",
              kind: "execute",
              title: "echo agy-probe-ok",
              rawInput: { CommandLine: "echo agy-probe-ok", BypassSandbox: true },
            },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
      } else if (msg.id === "1" && msg.result) {
        permissionReply = msg;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "230f98dd-cc2e-419b-aefa-abc1d0677987",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_1",
              name: "run_command",
              status: "completed",
              kind: "execute",
              title: "echo agy-probe-ok",
            },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "230f98dd-cc2e-419b-aefa-abc1d0677987",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "agy-probe-ok" },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: pendingPromptId,
          result: {
            stopReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 12, totalTokens: 112 },
          },
        });
      }
    });

    let registeredExecute!: (
      input: unknown,
      ctx: { sessionID: string },
    ) => Promise<{
      content?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: {
        assert: async (input) => {
          permissionAsserts.push(input);
        },
      },
      tool: {
        transform: async (fn) => {
          fn({
            add: (tool) => {
              registeredExecute = tool.execute;
            },
          });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);
    const result = await registeredExecute(
      { prompt: "Run echo agy-probe-ok" },
      { sessionID: "oc-sess-wire" },
    );

    expect(result.content).toBe(
      "agy-probe-ok\n\n[agy_session_id: 230f98dd-cc2e-419b-aefa-abc1d0677987]",
    );
    expect(permissionAsserts[0]?.action).toBe("bash");
    expect(permissionAsserts[0]?.resources).toEqual(["echo agy-probe-ok"]);
    expect(permissionAsserts[0]?.metadata?.name).toBe("run_command");
    expect(permissionReply?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(result.metadata?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 112,
    });
    expect(result.metadata?.toolCalls).toEqual([
      {
        id: "call_1",
        title: "echo agy-probe-ok",
        kind: "execute",
        status: "completed",
      },
    ]);

    await dispose();
  });

  test("starts fresh agy sessions by default, explicitly resumes session_id via session/load, and fails loudly on bad session_id", async () => {
    let newSessionCount = 0;
    const loadedSessions: string[] = [];

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        newSessionCount += 1;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: `agy-fresh-${newSessionCount}` },
        });
      } else if (msg.method === "session/load") {
        const params = msg.params as { sessionId: string };
        loadedSessions.push(params.sessionId);
        if (params.sessionId === "bad-session-id") {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Session not found" },
          });
        } else {
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      } else if (msg.method === "session/prompt") {
        const params = msg.params as { sessionId: string };
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `reply:${params.sessionId}` },
            },
          },
        });
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn" },
        });
      }
    });

    let registeredExecute!: (
      input: unknown,
      ctx: { sessionID: string },
    ) => Promise<{
      content?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: { assert: async () => {} },
      tool: {
        transform: async (fn) => {
          fn({ add: (tool) => { registeredExecute = tool.execute; } });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);

    const first = await registeredExecute({ prompt: "one" }, { sessionID: "oc-1" });
    const second = await registeredExecute({ prompt: "two" }, { sessionID: "oc-1" });
    const resumed = await registeredExecute(
      { prompt: "three", session_id: "agy-fresh-1" },
      { sessionID: "oc-1" },
    );
    const bad = await registeredExecute(
      { prompt: "four", session_id: "bad-session-id" },
      { sessionID: "oc-1" },
    );

    expect(first.metadata?.agySessionId).toBe("agy-fresh-1");
    expect(second.metadata?.agySessionId).toBe("agy-fresh-2");
    expect(resumed.metadata?.agySessionId).toBe("agy-fresh-1");
    expect(loadedSessions).toEqual(["agy-fresh-1", "bad-session-id"]);
    expect(newSessionCount).toBe(2);
    expect(bad.metadata?.code).toBe("SESSION_LOAD_FAILED");
    expect(bad.content).toContain("AGY_ERROR [SESSION_LOAD_FAILED]");

    await dispose();
  });

  test("runs multiple agy calls concurrently and streams rich step progress", async () => {
    let sessionSeq = 0;
    const pendingPrompts: Array<{
      id: number | string;
      sessionId: string;
      send: (reply: Record<string, unknown>) => void;
    }> = [];

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        sessionSeq += 1;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: `agy-par-${sessionSeq}` },
        });
      } else if (msg.method === "session/prompt") {
        const params = msg.params as { sessionId: string };
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "plan",
              entries: [
                { content: "Inspect files", status: "in_progress" },
                { content: "Run tests", status: "pending" },
              ],
            },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-read-1",
              title: "Read file",
              kind: "read",
              status: "in_progress",
              locations: [{ path: "src/index.ts" }],
            },
          },
        });
        pendingPrompts.push({
          id: msg.id as number | string,
          sessionId: params.sessionId,
          send,
        });
        // Only resolve once BOTH concurrent prompts are in flight simultaneously!
        if (pendingPrompts.length === 2) {
          for (const item of pendingPrompts) {
            item.send({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: item.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `done:${item.sessionId}` },
                },
              },
            });
            item.send({
              jsonrpc: "2.0",
              id: item.id,
              result: { stopReason: "end_turn" },
            });
          }
        }
      }
    });

    let registeredExecute!: (
      input: unknown,
      ctx: {
        sessionID: string;
        progress?: (u: Readonly<Record<string, unknown>>) => Promise<void>;
      },
    ) => Promise<{
      content?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: { assert: async () => {} },
      tool: {
        transform: async (fn) => {
          fn({ add: (tool) => { registeredExecute = tool.execute; } });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);

    const progress1: Array<Readonly<Record<string, unknown>>> = [];
    const [r1, r2] = await Promise.all([
      registeredExecute(
        { prompt: "task 1" },
        { sessionID: "oc-par", progress: async (u) => { progress1.push(u); } },
      ),
      registeredExecute({ prompt: "task 2" }, { sessionID: "oc-par" }),
    ]);

    expect(r1.metadata?.agySessionId).toBe("agy-par-1");
    expect(r2.metadata?.agySessionId).toBe("agy-par-2");
    const lastProgress = progress1[progress1.length - 1];
    expect(lastProgress?.toolCalls).toEqual([
      {
        id: "tc-read-1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        detail: "src/index.ts",
      },
    ]);
    expect(lastProgress?.plan).toEqual([
      { content: "Inspect files", status: "in_progress", priority: undefined },
      { content: "Run tests", status: "pending", priority: undefined },
    ]);

    await dispose();
  });

  test("forwards AbortSignal to ACP session/cancel", async () => {
    const cancelledSessions: string[] = [];
    let pendingPromptId = 0;

    const mock = createMockAcpServer((msg, send) => {
      if (msg.method === "initialize") {
        send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "agy-cancel-1" },
        });
      } else if (msg.method === "session/prompt") {
        pendingPromptId = msg.id as number;
      } else if (msg.method === "session/cancel") {
        const params = msg.params as { sessionId: string };
        cancelledSessions.push(params.sessionId);
        send({
          jsonrpc: "2.0",
          id: pendingPromptId,
          error: { code: -32800, message: "Request cancelled" },
        });
      }
    });

    let registeredExecute!: (
      input: unknown,
      ctx: { sessionID: string; signal?: AbortSignal },
    ) => Promise<{ content?: string }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: { assert: async () => {} },
      tool: {
        transform: async (fn) => {
          fn({ add: (tool) => { registeredExecute = tool.execute; } });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin({ spawn: mock.spawner });
    const dispose = await plugin.setup(fakeCtx);

    const controller = new AbortController();
    const turnPromise = registeredExecute(
      { prompt: "long running task" },
      { sessionID: "oc-cancel", signal: controller.signal },
    );

    await new Promise((r) => setTimeout(r, 15));
    controller.abort();

    await expect(turnPromise).rejects.toThrow("AGY_ACP_CANCELLED");
    expect(cancelledSessions).toEqual(["agy-cancel-1"]);

    await dispose();
  });

  test("returns structured AGY_ERROR [INVALID_ARGUMENT] on empty prompt", async () => {
    let registeredExecute!: (
      input: unknown,
      ctx: { sessionID: string },
    ) => Promise<{
      content?: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: { assert: async () => {} },
      tool: {
        transform: async (fn) => {
          fn({ add: (tool) => { registeredExecute = tool.execute; } });
          return { dispose: async () => {} };
        },
      },
    };

    const plugin = createAgyAcpPlugin();
    const dispose = await plugin.setup(fakeCtx);
    const res = await registeredExecute({ prompt: "   " }, { sessionID: "oc-empty" });

    expect(res.content).toContain("AGY_ERROR [INVALID_ARGUMENT]");
    expect(res.metadata?.error).toBe(true);
    expect(res.metadata?.code).toBe("INVALID_ARGUMENT");

    await dispose();
  });

  test("registers /agy command and opencode-agy-acp skill on OpenCode 2.x context", async () => {
    const commands: Array<{
      name: string;
      description?: string;
      execute: (input: OpenCodeCommandInvocationLike) => Promise<void>;
    }> = [];
    const skills = new Map<string, Record<string, unknown>>();
    const prompted: Array<Record<string, unknown>> = [];
    let disposedCount = 0;

    const fakeCtx: OpenCodePluginContextLike = {
      location: { directory: "/tmp/workspace" },
      permission: { assert: async () => {} },
      tool: {
        transform: async () => ({
          dispose: async () => {
            disposedCount += 1;
          },
        }),
      },
      command: {
        transform: async (fn) => {
          fn({
            add: (cmd) => {
              commands.push(cmd);
            },
          });
          return {
            dispose: async () => {
              disposedCount += 1;
            },
          };
        },
      },
      skill: {
        transform: async (fn) => {
          fn({
            get: (id) => skills.get(id),
            add: (skill) => {
              skills.set(skill.id, { ...skill });
            },
            update: (id, updater) => {
              const cur = skills.get(id);
              if (cur) updater(cur);
            },
          });
          return {
            dispose: async () => {
              disposedCount += 1;
            },
          };
        },
      },
      session: {
        prompt: async (input) => {
          prompted.push(input as unknown as Record<string, unknown>);
        },
      },
    };

    const plugin = createAgyAcpPlugin();
    const dispose = await plugin.setup(fakeCtx);

    expect(commands.length).toBe(1);
    expect(commands[0]?.name).toBe("agy");
    await commands[0]!.execute({
      sessionID: "oc-cmd-1",
      prompt: { text: "Review src/acp.ts", files: [{ uri: "file:///tmp/a.ts" }] },
      delivery: "steer",
    });

    expect(prompted.length).toBe(1);
    expect(prompted[0]?.sessionID).toBe("oc-cmd-1");
    expect(String(prompted[0]?.text)).toContain("Review src/acp.ts");
    expect(String(prompted[0]?.text)).toContain("gemini-4");
    expect(String(prompted[0]?.text)).not.toContain("flash-3.8");
    expect(prompted[0]?.delivery).toBe("steer");

    const skill = skills.get("opencode-agy-acp");
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("opencode-agy-acp");
    expect(String(skill?.content)).not.toContain("---\nname:");
    expect(String(skill?.content)).toContain("gemini-4-{neon|hydrogen}-{low|medium|high|xhigh}");
    expect(String(skill?.content)).not.toContain("flash-3.8");

    await dispose();
    expect(disposedCount).toBe(3);
  });
});

describe("errors and markdown helpers", () => {
  test("classifies structured AGY_ERROR codes and scrubs secrets", () => {
    expect(classifyAgyError(new Error("AGY_ACP_TIMEOUT: prompt exceeded 1000ms"))).toBe("TIMEOUT");
    expect(classifyAgyError(new Error("spawn agy ENOENT"))).toBe("AGY_NOT_FOUND");
    expect(classifyAgyError(new Error("401 Unauthenticated"))).toBe("AUTH_REQUIRED");
    expect(classifyAgyError(new Error("429 RESOURCE_EXHAUSTED quota"))).toBe("QUOTA_EXHAUSTED");
    expect(classifyAgyError(new Error("Unknown model foo"))).toBe("MODEL_NOT_FOUND");
    expect(classifyAgyError(new Error("something else"))).toBe("AGY_FAILED");

    const timeoutRes = formatAgyErrorResult(
      new Error("AGY_ACP_TIMEOUT: prompt exceeded 60000ms (session_id=s-1)"),
      { agySessionId: "s-1", timeoutMs: 60_000, partialOutput: "halfway done" },
    );
    expect(timeoutRes.content).toContain("AGY_ERROR [TIMEOUT]");
    expect(timeoutRes.content).toContain('session_id="s-1"');
    expect(timeoutRes.metadata.suggestedNextTimeoutMs).toBe(30 * 60 * 1000);
    expect(timeoutRes.metadata.timedOut).toBe(true);

    expect(scrubSecrets("Authorization: Bearer ya29.supersecretvalue123456")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("parses frontmatter markdown and substitutes $ARGUMENTS", () => {
    const parsed = parseFrontmatterMarkdown("---\ndescription: Test cmd\n---\nRun $ARGUMENTS");
    expect(parsed.frontmatter.description).toBe("Test cmd");
    expect(buildAgyCommandPrompt(parsed.body, "fix tests")).toBe("Run fix tests");
  });
});
