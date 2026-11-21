// Maps ACP `session/request_permission` payloads onto OpenCode 2.0's
// `ctx.permission.assert(...)` and translates the outcome back into an ACP
// permission response.

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | string;
}

export interface AcpToolCallLocation {
  readonly path?: string;
  readonly line?: number;
}

export interface AcpPermissionToolCall {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly locations?: readonly AcpToolCallLocation[];
}

export interface AcpRequestPermissionParams {
  readonly sessionId: string;
  readonly toolCall?: AcpPermissionToolCall;
  readonly options?: readonly AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export interface OpenCodePermissionAssertInput {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly source?: {
    readonly type: "tool";
    readonly messageID: string;
    readonly id: string;
  };
}

export interface OpenCodePermissionBridgeContext {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly toolCallID?: string;
  readonly signal?: AbortSignal;
  readonly assertPermission: (
    input: OpenCodePermissionAssertInput,
  ) => Promise<void>;
}

export interface MappedOpenCodePermission {
  readonly action: string;
  readonly resources: string[];
  readonly metadata: Record<string, unknown>;
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

function extractPaths(toolCall: AcpPermissionToolCall | undefined): string[] {
  const paths: string[] = [];
  if (Array.isArray(toolCall?.locations)) {
    for (const loc of toolCall.locations) {
      const p = nonEmptyString(loc?.path);
      if (p) paths.push(p);
    }
  }
  const input = asRecord(toolCall?.rawInput);
  if (input) {
    for (const key of ["path", "Path", "file_path", "filePath", "target", "TargetFile", "AbsolutePath"]) {
      const p = nonEmptyString(input[key]);
      if (p && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

function extractCommand(toolCall: AcpPermissionToolCall | undefined): string | undefined {
  const input = asRecord(toolCall?.rawInput);
  if (!input) return undefined;
  for (const key of ["command", "CommandLine", "cmd", "script"]) {
    const cmd = nonEmptyString(input[key]);
    if (cmd) return cmd;
  }
  return undefined;
}

function extractUrl(toolCall: AcpPermissionToolCall | undefined): string | undefined {
  const input = asRecord(toolCall?.rawInput);
  if (!input) return undefined;
  for (const key of ["url", "Url", "uri", "query"]) {
    const u = nonEmptyString(input[key]);
    if (u) return u;
  }
  return undefined;
}

/**
 * Maps an ACP `toolCall` from `session/request_permission` into OpenCode 2.0's
 * `(action, resources, metadata)` permission model so existing rules in
 * `opencode.json` (`read`, `edit`, `bash`, `webfetch`, `agy`) apply naturally.
 */
export function mapAcpToolCallToOpenCodePermission(
  toolCall: AcpPermissionToolCall | undefined,
): MappedOpenCodePermission {
  const kind = (toolCall?.kind ?? "").toLowerCase();
  const title = nonEmptyString(toolCall?.title) ?? kind ?? "agy-tool";
  const paths = extractPaths(toolCall);
  const command = extractCommand(toolCall);
  const url = extractUrl(toolCall);

  const metadata: Record<string, unknown> = {
    source: "agy-acp",
    toolCallId: toolCall?.toolCallId,
    kind: toolCall?.kind,
    title,
    rawInput: toolCall?.rawInput,
  };

  if (
    kind === "execute" ||
    kind === "bash" ||
    kind === "shell" ||
    kind === "terminal" ||
    command !== undefined
  ) {
    return {
      action: "bash",
      resources: [command ?? title],
      metadata,
    };
  }

  if (
    kind === "edit" ||
    kind === "write" ||
    kind === "delete" ||
    kind === "move"
  ) {
    return {
      action: "edit",
      resources: paths.length > 0 ? paths : [title],
      metadata,
    };
  }

  if (
    kind === "read" ||
    kind === "search" ||
    kind === "glob" ||
    kind === "grep"
  ) {
    return {
      action: "read",
      resources: paths.length > 0 ? paths : [title],
      metadata,
    };
  }

  if (kind === "fetch" || kind === "web" || url !== undefined) {
    return {
      action: "webfetch",
      resources: [url ?? title],
      metadata,
    };
  }

  return {
    action: "agy",
    resources: paths.length > 0 ? paths : [title],
    metadata,
  };
}

export function selectPermissionOptionId(
  options: readonly AcpPermissionOption[] | undefined,
  decision: "allow" | "reject",
): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;

  if (decision === "allow") {
    return (
      options.find((o) => o.kind === "allow_once")?.optionId ??
      options.find((o) => o.kind === "allow_always")?.optionId ??
      options.find((o) => /allow|approve|yes/i.test(o.optionId) || /allow|approve|yes/i.test(o.name ?? ""))?.optionId ??
      options[0]?.optionId
    );
  }

  return (
    options.find((o) => o.kind === "reject_once")?.optionId ??
    options.find((o) => o.kind === "reject_always")?.optionId ??
    options.find((o) => /reject|deny|cancel|no/i.test(o.optionId) || /reject|deny|cancel|no/i.test(o.name ?? ""))?.optionId
  );
}

/**
 * Evaluates an ACP `session/request_permission` request through OpenCode's
 * `ctx.permission.assert(...)`.
 *
 * - Allowed -> `{ outcome: "selected", optionId: <allow_once> }`
 * - Denied -> `{ outcome: "selected", optionId: <reject_once> }` (or `"cancelled"` if no reject option exists)
 * - Aborted -> `{ outcome: "cancelled" }`
 */
export async function handleAcpPermissionRequest(
  params: AcpRequestPermissionParams,
  bridge: OpenCodePermissionBridgeContext,
): Promise<{ readonly outcome: AcpPermissionOutcome }> {
  if (bridge.signal?.aborted) {
    return { outcome: { outcome: "cancelled" } };
  }

  const mapped = mapAcpToolCallToOpenCodePermission(params.toolCall);
  const assertInput: OpenCodePermissionAssertInput = {
    sessionID: bridge.sessionID,
    ...(bridge.agent ? { agent: bridge.agent } : {}),
    action: mapped.action,
    resources: mapped.resources,
    metadata: mapped.metadata,
    ...(bridge.messageID && bridge.toolCallID
      ? {
          source: {
            type: "tool" as const,
            messageID: bridge.messageID,
            id: bridge.toolCallID,
          },
        }
      : {}),
  };

  try {
    await bridge.assertPermission(assertInput);
    if (bridge.signal?.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    const allowId = selectPermissionOptionId(params.options, "allow");
    if (!allowId) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: allowId } };
  } catch {
    if (bridge.signal?.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    const rejectId = selectPermissionOptionId(params.options, "reject");
    if (rejectId) {
      return { outcome: { outcome: "selected", optionId: rejectId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }
}
