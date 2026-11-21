import { describe, expect, test } from "bun:test";
import {
  AcpClient,
  buildScrubbedEnv,
  type AcpProcessLike,
  type AcpSpawner,
} from "../src/acp.ts";
import {
  createAgyAcpPlugin,
  type OpenCodePluginContextLike,
} from "../src/index.ts";
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
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let exitCode: number | null = null;
  const encoder = new TextEncoder();

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

  let stdinBuf = "";
  const proc: AcpProcessLike = {
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

  return {
    spawner: (opts) => {
      lastEnv = opts.env;
      return proc;
    },
    received,
    spawnedEnv: () => lastEnv,
    send,
    exit,
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

    expect(result.content).toBe("Edited src/app.ts successfully.");
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

    expect(result.content).toBe("Skipped command after denial.");
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
});
