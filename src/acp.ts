// Bidirectional NDJSON JSON-RPC 2.0 ACP client for `agy acp`.
//
// Zero runtime npm dependencies: uses Bun.spawn directly and follows the pipe
// draining, cancellation, and process-reaping hygiene proven in Pasture's
// OpenCode 2.0 plugin.

import type {
  AcpPermissionOutcome,
  AcpRequestPermissionParams,
} from "./permissions.ts";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface AcpProcessLike {
  readonly stdin: {
    write(chunk: string | Uint8Array): number | Promise<number>;
    flush?(): void | Promise<void>;
    end?(): void | Promise<void>;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
}

export type AcpSpawner = (opts: {
  cmd: string[];
  cwd?: string;
  env: Record<string, string>;
}) => AcpProcessLike;

export interface AcpClientOptions {
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly spawn?: AcpSpawner;
  readonly onUpdate?: (params: Record<string, unknown>) => void | Promise<void>;
  readonly onPermissionRequest?: (
    params: AcpRequestPermissionParams,
  ) => Promise<{ readonly outcome: AcpPermissionOutcome }>;
  readonly onStderr?: (chunk: string) => void;
}

export interface AcpPromptResult {
  readonly stopReason: string;
  readonly raw: Record<string, unknown>;
}

const MAX_STDERR_CHARS = 16_384;

const ALLOWED_ENV_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const ALLOWED_ENV_PREFIXES = ["LC_", "XDG_", "AGY_", "NIX_"];

/**
 * Scrubs the parent OpenCode environment so unrelated provider API keys
 * (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY) are never leaked into `agy acp`.
 */
export function buildScrubbedEnv(
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== "string") continue;
    if (
      ALLOWED_ENV_EXACT.has(key) ||
      ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      out[key] = value;
    }
  }
  return out;
}

function defaultSpawn(opts: {
  cmd: string[];
  cwd?: string;
  env: Record<string, string>;
}): AcpProcessLike {
  return Bun.spawn({
    cmd: opts.cmd,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as AcpProcessLike;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class AcpClient {
  private readonly options: AcpClientOptions;
  private proc: AcpProcessLike | null = null;
  private stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoops: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private initialized = false;
  private closed = false;
  private stderrBuffer = "";
  private activeUpdateHandler:
    | ((params: Record<string, unknown>) => void | Promise<void>)
    | undefined;
  private activePermissionHandler:
    | ((
        params: AcpRequestPermissionParams,
      ) => Promise<{ readonly outcome: AcpPermissionOutcome }>)
    | undefined;

  constructor(options: AcpClientOptions = {}) {
    this.options = options;
    this.activeUpdateHandler = options.onUpdate;
    this.activePermissionHandler = options.onPermissionRequest;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.closed && this.proc.exitCode === null;
  }

  get stderrTail(): string {
    return this.stderrBuffer;
  }

  waitForExit(): Promise<number | null> {
    return this.proc ? this.proc.exited : Promise.resolve(null);
  }

  setTurnHandlers(handlers: {
    onUpdate?: (params: Record<string, unknown>) => void | Promise<void>;
    onPermissionRequest?: (
      params: AcpRequestPermissionParams,
    ) => Promise<{ readonly outcome: AcpPermissionOutcome }>;
  }): void {
    this.activeUpdateHandler = handlers.onUpdate ?? this.options.onUpdate;
    this.activePermissionHandler =
      handlers.onPermissionRequest ?? this.options.onPermissionRequest;
  }

  async ensureStarted(): Promise<void> {
    if (this.isRunning && this.initialized) return;

    if (this.proc !== null) {
      await this.close();
    }

    this.closed = false;
    this.initialized = false;
    this.stderrBuffer = "";

    const binary = this.options.binary ?? process.env.AGY_BIN ?? "agy";
    const args = this.options.args ?? ["acp"];
    const spawn = this.options.spawn ?? defaultSpawn;
    const env = buildScrubbedEnv(this.options.env);

    this.proc = spawn({
      cmd: [binary, ...args],
      cwd: this.options.cwd,
      env,
    });

    this.stdoutReader = this.proc.stdout.getReader();
    this.stderrReader = this.proc.stderr.getReader();

    const stdoutLoop = this.consumeStdout(this.stdoutReader);
    const stderrLoop = this.consumeStderr(this.stderrReader);
    const exitWatcher = this.proc.exited.then((code) => {
      if (!this.closed) {
        this.rejectAllPending(
          new Error(
            `agy acp exited unexpectedly with code ${code}${this.stderrBuffer ? `: ${this.stderrBuffer.trim().slice(-500)}` : ""}`,
          ),
        );
      }
      this.initialized = false;
    });

    this.readLoops = Promise.allSettled([
      stdoutLoop,
      stderrLoop,
      exitWatcher,
    ]).then(() => {});

    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "opencode-agy-acp",
        version: "0.1.0",
      },
      clientCapabilities: {},
    });

    this.initialized = true;
  }

  async newSession(cwd: string): Promise<string> {
    await this.ensureStarted();
    const res = (await this.request("session/new", {
      cwd,
      mcpServers: [],
    })) as Record<string, unknown> | undefined;
    const sessionId =
      typeof res?.sessionId === "string" ? res.sessionId.trim() : "";
    if (!sessionId) {
      throw new Error(
        `agy acp session/new returned no sessionId: ${JSON.stringify(res)}`,
      );
    }
    return sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.ensureStarted();
    await this.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureStarted();
    await this.request("session/set_model", {
      sessionId,
      modelId,
    });
  }

  async prompt(
    sessionId: string,
    text: string,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AcpPromptResult> {
    await this.ensureStarted();

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      void this.cancelSession(sessionId).catch(() => {});
    };

    if (opts.signal?.aborted) {
      throw new Error("Aborted before sending prompt to agy acp");
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const promptPromise = this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });

      const rawResult =
        typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
          ? await Promise.race([
              promptPromise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  timedOut = true;
                  void this.cancelSession(sessionId).catch(() => {});
                  reject(
                    new Error(
                      `AGY_ACP_TIMEOUT: prompt exceeded ${opts.timeoutMs}ms (session_id=${sessionId})`,
                    ),
                  );
                }, opts.timeoutMs);
              }),
            ])
          : await promptPromise;

      const raw =
        rawResult !== null && typeof rawResult === "object"
          ? (rawResult as Record<string, unknown>)
          : {};
      const stopReason =
        typeof raw.stopReason === "string"
          ? raw.stopReason
          : typeof raw.stop_reason === "string"
            ? raw.stop_reason
            : "end_turn";

      return { stopReason, raw };
    } catch (error) {
      if (timedOut) throw error;
      if (opts.signal?.aborted) {
        throw new Error(
          `AGY_ACP_CANCELLED: prompt aborted by OpenCode (session_id=${sessionId})`,
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    if (!this.isRunning) return;
    await this.notify("session/cancel", { sessionId });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc || this.closed) {
      throw new Error(`Cannot send ACP request "${method}": client is not running`);
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.writeLine(payload).catch((error) => {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.proc || this.closed) return;
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.writeLine(payload);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
    this.rejectAllPending(new Error("ACP client closed"));

    const proc = this.proc;
    this.proc = null;

    const stdoutReader = this.stdoutReader;
    const stderrReader = this.stderrReader;
    this.stdoutReader = null;
    this.stderrReader = null;

    if (proc) {
      try {
        await proc.stdin.end?.();
      } catch {
        // ignore close errors on already-closed stdin
      }
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore if already exited
        }
      }
    }

    await Promise.allSettled([
      stdoutReader?.cancel(),
      stderrReader?.cancel(),
      proc?.exited,
      this.readLoops,
    ]);

    try {
      stdoutReader?.releaseLock();
    } catch {
      // ignore if already released
    }
    try {
      stderrReader?.releaseLock();
    } catch {
      // ignore if already released
    }

    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    this.readLoops = null;
  }

  private async writeLine(message: unknown): Promise<void> {
    if (!this.proc) {
      throw new Error("ACP process is not running");
    }
    const line = JSON.stringify(message) + "\n";
    await this.proc.stdin.write(line);
    await this.proc.stdin.flush?.();
  }

  private async consumeStdout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line !== "") {
            await this.handleLine(line);
          }
          newlineIdx = buffer.indexOf("\n");
        }
      }
      const trailing = buffer.trim();
      if (trailing !== "") {
        await this.handleLine(trailing);
      }
    } catch {
      // Stream cancelled or closed during shutdown
    }
  }

  private async consumeStderr(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const tail = decoder.decode();
          if (tail) this.appendStderr(tail);
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) this.appendStderr(chunk);
      }
    } catch {
      // Stream cancelled or closed during shutdown
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > MAX_STDERR_CHARS) {
      this.stderrBuffer = this.stderrBuffer.slice(-MAX_STDERR_CHARS);
    }
    this.options.onStderr?.(chunk);
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON diagnostic line emitted on stdout; ignore safely.
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const hasId = typeof msg.id === "number" || typeof msg.id === "string";
    const hasMethod = typeof msg.method === "string";

    // 1. Response to one of our outgoing requests
    if (hasId && !hasMethod) {
      const id = msg.id as number | string;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);

      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as Record<string, unknown>;
        const message =
          typeof errObj.message === "string"
            ? errObj.message
            : JSON.stringify(errObj);
        entry.reject(
          new Error(`ACP "${entry.method}" failed (${String(errObj.code ?? "error")}): ${message}`),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 2. Server-initiated JSON-RPC request (expects a response with matching id)
    if (hasId && hasMethod) {
      const id = msg.id as number | string;
      const method = msg.method as string;
      // Handle asynchronously so the stdout reader never blocks while waiting
      // on a user permission prompt or concurrent notifications.
      void this.handleServerRequest(id, method, msg.params);
      return;
    }

    // 3. Server notification (no id)
    if (!hasId && hasMethod) {
      const method = msg.method as string;
      if (
        method === "session/update" &&
        msg.params !== null &&
        typeof msg.params === "object"
      ) {
        try {
          await this.activeUpdateHandler?.(
            msg.params as Record<string, unknown>,
          );
        } catch {
          // Notification handler failures must not kill the read loop
        }
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method === "session/request_permission") {
      try {
        const handler = this.activePermissionHandler;
        const result = handler
          ? await handler((params ?? {}) as AcpRequestPermissionParams)
          : { outcome: { outcome: "cancelled" as const } };
        await this.writeLine({
          jsonrpc: "2.0",
          id,
          result,
        } satisfies JsonRpcResponse);
      } catch (error) {
        await this.writeLine({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "cancelled" } },
        } satisfies JsonRpcResponse).catch(() => {});
        console.error("opencode-agy-acp: permission handler failed:", error);
      }
      return;
    }

    await this.writeLine({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not implemented by opencode-agy-acp client: ${method}`,
      },
    } satisfies JsonRpcResponse).catch(() => {});
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}
