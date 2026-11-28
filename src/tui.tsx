/** @jsxImportSource @opentui/solid */
// OpenCode 2.0 TUI plugin for `opencode-agy-acp`.
//
// Renders live-streaming `agy acp` steps from the per-session trace store:
// 1. `prompt.footer.status`: compact single-line live indicator (0 extra vertical height).
// 2. `session.panel`: scrollable, collapsible full step trace (`/agy-trace`) with
//    live backgrounding (`b`) and cancellation (`x`) controls.

import { Plugin } from "@opencode/plugin/tui";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type { AgyPlanEntry, AgyToolCallSummary } from "./index.ts";
import {
  collapseConsecutiveSteps,
  getSessionTraceMtime,
  readSessionTraces,
  requestRunControl,
  type AgyTraceRun,
  type AgyTraceStatus,
} from "./trace.ts";

const PANEL_NAME = "agy-trace";
const RECENT_STEPS_LIMIT = 15;
const STALE_ZOMBIE_MS = 15_000;

interface AgyRunView {
  readonly id: string;
  readonly status: AgyTraceStatus;
  readonly background?: boolean;
  readonly prompt: string;
  readonly agySessionId?: string;
  readonly model?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly currentActivity?: string;
  readonly toolCallCount: number;
  readonly toolCalls: readonly AgyToolCallSummary[];
  readonly plan: readonly AgyPlanEntry[];
  readonly latestThought?: string;
  readonly latestText?: string;
  readonly charsReceived: number;
  readonly errorMessage?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRunningStatus(status: AgyTraceStatus): boolean {
  return status === "running" || status === "streaming";
}

function parseToolCalls(value: unknown): AgyToolCallSummary[] {
  if (!Array.isArray(value)) return [];
  const out: AgyToolCallSummary[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const title = asString(rec.title);
    if (!title) continue;
    out.push({
      id: asString(rec.id) ?? `tc-${out.length + 1}`,
      title,
      kind: asString(rec.kind),
      status: asString(rec.status),
      detail: asString(rec.detail),
    });
  }
  return out;
}

function parsePlan(value: unknown): AgyPlanEntry[] {
  if (!Array.isArray(value)) return [];
  const out: AgyPlanEntry[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const content = asString(rec?.content);
    if (!content) continue;
    out.push({
      content,
      status: asString(rec?.status),
      priority: asString(rec?.priority),
    });
  }
  return out;
}

function extractAgyRunsFromMessages(messages: readonly unknown[]): AgyRunView[] {
  const runs: AgyRunView[] = [];
  for (const rawMessage of messages) {
    const msg = asRecord(rawMessage);
    if (msg?.type !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const rawPart of msg.content) {
      const part = asRecord(rawPart);
      if (part?.type !== "tool") continue;
      const state = asRecord(part.state);
      const status = state?.status;
      if (
        status !== "streaming" &&
        status !== "running" &&
        status !== "completed" &&
        status !== "error"
      ) {
        continue;
      }

      if (part.name === "agy") {
        const input = asRecord(state?.input);
        const meta = asRecord(state?.metadata) ?? {};
        const toolCalls = parseToolCalls(meta.toolCalls);
        const plan = parsePlan(meta.plan);
        const errorObj = asRecord(state?.error);
        const background =
          meta.background === true || input?.background === true;
        const effectivePartStatus: AgyTraceStatus =
          meta.cancelled === true
            ? "cancelled"
            : meta.error === true
              ? "error"
              : status;

        runs.push({
          id: asString(meta.jobId) ?? asString(part.id) ?? `agy-${runs.length + 1}`,
          status: effectivePartStatus,
          ...(background ? { background: true } : {}),
          prompt: asString(input?.prompt) ?? "",
          agySessionId: asString(meta.agySessionId) ?? asString(input?.session_id),
          model: asString(meta.model) ?? asString(input?.model),
          startedAt: asNumber(meta.startedAt),
          completedAt: asNumber(meta.completedAt),
          currentActivity: asString(meta.currentActivity),
          toolCallCount: asNumber(meta.toolCallCount) ?? toolCalls.length,
          toolCalls,
          plan,
          latestThought: asString(meta.latestThought),
          latestText: asString(meta.latestText),
          charsReceived: asNumber(meta.charsReceived) ?? 0,
          errorMessage: asString(errorObj?.message),
        });
        continue;
      }

      // Code Mode (`execute`) nests `agy` calls inside `state.metadata.toolCalls`.
      if (part.name === "execute") {
        const meta = asRecord(state?.metadata);
        const nested = Array.isArray(meta?.toolCalls) ? meta.toolCalls : [];
        let idx = 0;
        for (const rawCall of nested) {
          const call = asRecord(rawCall);
          if (call?.tool !== "agy") continue;
          idx += 1;
          const callStatus: AgyTraceStatus =
            call.status === "running" ||
            call.status === "completed" ||
            call.status === "error"
              ? call.status
              : status;
          const callInput = asRecord(call.input);
          runs.push({
            id: `${asString(part.id) ?? "exec"}:agy:${idx}`,
            status: callStatus,
            ...(callInput?.background === true ? { background: true } : {}),
            prompt: asString(callInput?.prompt) ?? "",
            agySessionId: asString(callInput?.session_id),
            model: asString(callInput?.model),
            toolCallCount: 0,
            toolCalls: [],
            plan: [],
            charsReceived: 0,
          });
        }
      }
    }
  }
  return runs;
}

function mergeAgyRuns(
  traceRuns: readonly AgyTraceRun[],
  messageRuns: readonly AgyRunView[],
  sessionIdle: boolean,
): AgyRunView[] {
  const byId = new Map<string, AgyRunView>();
  const tracePrompts = new Set<string>();

  for (const run of traceRuns) {
    // Active server runs refresh `updatedAt` via a 2.5s heartbeat even when the
    // parent OpenCode session is idle (e.g. detached background runs). Only age
    // out genuinely orphaned entries if the server crashed without `finally`.
    const effectiveStatus: AgyTraceStatus =
      sessionIdle &&
      isRunningStatus(run.status) &&
      Date.now() - run.updatedAt > STALE_ZOMBIE_MS
        ? "error"
        : run.status;
    byId.set(run.id, {
      ...run,
      status: effectiveStatus,
    });
    if (run.prompt) tracePrompts.add(run.prompt);
  }

  for (const run of messageRuns) {
    if (byId.has(run.id)) continue;
    // Avoid duplicating a Code Mode `execute` synthetic entry when the live
    // file-backed trace already captured that run's full steps.
    if (run.id.includes(":agy:") && run.prompt && tracePrompts.has(run.prompt)) {
      continue;
    }
    byId.set(run.id, run);
  }

  return Array.from(byId.values());
}

function useSessionAgyRuns(
  sessionID: Accessor<string>,
  messages: Accessor<readonly unknown[]>,
  sessionStatus: Accessor<"idle" | "running">,
): Accessor<AgyRunView[]> {
  const [traceRuns, setTraceRuns] = createSignal<AgyTraceRun[]>([]);

  createEffect(() => {
    const sid = sessionID();
    let lastMtime = -1;
    const refresh = () => {
      const mtime = getSessionTraceMtime(sid);
      if (mtime === lastMtime) return;
      lastMtime = mtime;
      setTraceRuns(mtime > 0 ? readSessionTraces(sid) : []);
    };
    refresh();
    const timer = setInterval(refresh, 250);
    onCleanup(() => clearInterval(timer));
  });

  return createMemo(() =>
    mergeAgyRuns(
      traceRuns(),
      extractAgyRunsFromMessages(messages()),
      sessionStatus() === "idle",
    ),
  );
}

function formatDuration(startedAt: number | undefined, endedAt: number): string {
  if (!startedAt) return "";
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs}s`;
}

function shortId(id: string | undefined): string {
  if (!id) return "";
  return id.length > 10 ? id.slice(0, 8) : id;
}

function truncateLine(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, Math.max(1, maxChars - 1)) + "…";
}

function planIcon(status: string | undefined): string {
  const st = (status ?? "").toLowerCase();
  if (st === "completed" || st === "done") return "✓";
  if (st === "in_progress" || st === "running") return "●";
  return "○";
}

export default Plugin.define({
  id: "dayvidpham.opencode-agy-acp",
  setup(ctx) {
    const togglePanel = () => {
      if (ctx.ui.panel.current()?.name === PANEL_NAME) {
        ctx.ui.panel.close();
      } else {
        ctx.ui.panel.open(PANEL_NAME, { presentation: "panel" });
      }
    };

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "agy.trace.toggle",
          title: "Toggle agy trace panel",
          description: "Open or close the live Antigravity (agy) step trace panel",
          group: "Antigravity",
          palette: true,
          slash: { name: "agy-trace" },
          run: togglePanel,
        },
      ],
    }));

    const disposeFooterStatus = ctx.ui.slot({
      prepend: "prompt.footer.status",
      render(input) {
        const allRuns = useSessionAgyRuns(
          () => input.sessionID ?? "",
          () => (input.sessionID ? ctx.data.session.message.list(input.sessionID) : []),
          () => (input.sessionID ? ctx.data.session.status(input.sessionID) : "idle"),
        );
        const runningRuns = createMemo(() =>
          allRuns().filter((run) => isRunningStatus(run.status)),
        );
        const [hovered, setHovered] = createSignal(false);

        const summary = createMemo(() => {
          const active = runningRuns();
          if (active.length === 0) return "";
          const bgCount = active.filter((r) => r.background).length;
          if (active.length === 1) {
            const run = active[0]!;
            const bgTag = run.background ? " bg" : "";
            const steps =
              run.toolCallCount > 0
                ? ` (${run.toolCallCount} ${run.toolCallCount === 1 ? "step" : "steps"})`
                : "";
            return `◈ 1 agy${bgTag}${steps} · `;
          }
          const totalSteps = active.reduce((acc, r) => acc + r.toolCallCount, 0);
          const details: string[] = [];
          if (bgCount > 0) details.push(`${bgCount} bg`);
          if (totalSteps > 0) details.push(`${totalSteps} steps`);
          return `◈ ${active.length} agy${details.length > 0 ? ` (${details.join(" · ")})` : ""} · `;
        });

        return (
          <Show when={input.mode === "normal" && runningRuns().length > 0}>
            <box
              flexShrink={0}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => ctx.ui.panel.open(PANEL_NAME, { presentation: "panel" })}
            >
              <text
                fg={hovered() ? ctx.theme.text.base : ctx.theme.text.muted}
                wrapMode="none"
              >
                {summary()}
              </text>
            </box>
          </Show>
        );
      },
    });

    const disposePanel = ctx.ui.slot({
      append: "session.panel",
      render(input) {
        const isActivePanel = createMemo(() => input.name === PANEL_NAME);
        const focused = createMemo(
          () =>
            isActivePanel() &&
            (input.presentation === "fullscreen" || input.focused === true),
        );
        const sessionRuns = useSessionAgyRuns(
          () => input.sessionID,
          () => ctx.data.session.message.list(input.sessionID),
          () => ctx.data.session.status(input.sessionID),
        );
        const allRuns = createMemo(() => [...sessionRuns()].reverse());
        const hasRunning = createMemo(() =>
          allRuns().some((r) => isRunningStatus(r.status)),
        );

        // Explicit user collapse/expand overrides keyed by run.id.
        // Default: running runs are expanded, settled runs are collapsed.
        const [overrides, setOverrides] = createSignal<Record<string, boolean>>({});
        const [showAllStepsByRun, setShowAllStepsByRun] = createSignal<
          Record<string, boolean>
        >({});
        const [pendingControl, setPendingControl] = createSignal<
          Record<string, "cancelling" | "backgrounding">
        >({});
        const [selectedIndex, setSelectedIndex] = createSignal(0);

        createEffect(() => {
          const runs = allRuns();
          const count = runs.length;
          if (count === 0) {
            setSelectedIndex(0);
          } else if (selectedIndex() >= count) {
            setSelectedIndex(count - 1);
          }

          // Clear optimistic control badges once the trace reflects the state change.
          const pending = pendingControl();
          let changed = false;
          const next = { ...pending };
          for (const run of runs) {
            const cur = next[run.id];
            if (!cur) continue;
            if (
              !isRunningStatus(run.status) ||
              (cur === "backgrounding" && run.background)
            ) {
              delete next[run.id];
              changed = true;
            }
          }
          if (changed) setPendingControl(next);
        });

        const isExpanded = (run: AgyRunView): boolean => {
          const override = overrides()[run.id];
          if (override !== undefined) return override;
          return isRunningStatus(run.status);
        };

        const toggleRun = (run: AgyRunView) => {
          const next = !isExpanded(run);
          setOverrides((prev) => ({ ...prev, [run.id]: next }));
        };

        const toggleAllSteps = (runId: string) => {
          setShowAllStepsByRun((prev) => ({ ...prev, [runId]: !prev[runId] }));
        };

        const setAllExpanded = (expanded: boolean) => {
          const next: Record<string, boolean> = {};
          for (const run of allRuns()) {
            next[run.id] = expanded;
          }
          setOverrides(next);
        };

        const cancelRun = (run: AgyRunView | undefined) => {
          if (!run || !isRunningStatus(run.status)) return;
          setPendingControl((prev) => ({ ...prev, [run.id]: "cancelling" }));
          requestRunControl(input.sessionID, run.id, "cancel");
        };

        const backgroundRun = (run: AgyRunView | undefined) => {
          if (!run || !isRunningStatus(run.status) || run.background) return;
          setPendingControl((prev) => ({ ...prev, [run.id]: "backgrounding" }));
          requestRunControl(input.sessionID, run.id, "background");
        };

        const moveSelection = (delta: number) => {
          const count = allRuns().length;
          if (count === 0) return;
          setSelectedIndex((idx) => (idx + delta + count) % count);
        };

        let scroll:
          | {
              scrollBy?: (delta: number) => void;
              scrollTo?: (y: number) => void;
              scrollHeight?: number;
            }
          | undefined;

        const [now, setNow] = createSignal(Date.now());
        createEffect(() => {
          if (!hasRunning()) return;
          setNow(Date.now());
          const timer = setInterval(() => setNow(Date.now()), 1000);
          onCleanup(() => clearInterval(timer));
        });

        ctx.keymap.layer(() => ({
          enabled: () => focused(),
          priority: 10,
          commands: [
            {
              bind: "f",
              title: "Toggle fullscreen",
              group: "Antigravity",
              run: () => input.toggleFullscreen(),
            },
            {
              bind: "q",
              title: "Close agy trace panel",
              group: "Antigravity",
              run: () => input.close(),
            },
            {
              bind: "escape",
              title: "Close agy trace panel",
              group: "Antigravity",
              run: () => input.close(),
            },
            {
              bind: "tab",
              title: "Next trajectory",
              group: "Antigravity",
              run: () => moveSelection(1),
            },
            {
              bind: "shift+tab",
              title: "Previous trajectory",
              group: "Antigravity",
              run: () => moveSelection(-1),
            },
            {
              bind: "return",
              title: "Toggle selected trajectory",
              group: "Antigravity",
              run: () => {
                const run = allRuns()[selectedIndex()];
                if (run) toggleRun(run);
              },
            },
            {
              bind: "space",
              title: "Toggle selected trajectory",
              group: "Antigravity",
              run: () => {
                const run = allRuns()[selectedIndex()];
                if (run) toggleRun(run);
              },
            },
            {
              bind: "x",
              title: "Cancel selected running trajectory",
              group: "Antigravity",
              run: () => cancelRun(allRuns()[selectedIndex()]),
            },
            {
              bind: "b",
              title: "Move selected trajectory to background",
              group: "Antigravity",
              run: () => backgroundRun(allRuns()[selectedIndex()]),
            },
            {
              bind: "c",
              title: "Collapse all trajectories",
              group: "Antigravity",
              run: () => setAllExpanded(false),
            },
            {
              bind: "e",
              title: "Expand all trajectories",
              group: "Antigravity",
              run: () => setAllExpanded(true),
            },
            {
              bind: "s",
              title: "Toggle all steps on selected trajectory",
              group: "Antigravity",
              run: () => {
                const run = allRuns()[selectedIndex()];
                if (run) toggleAllSteps(run.id);
              },
            },
            {
              bind: "j",
              title: "Scroll down",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(2),
            },
            {
              bind: "down",
              title: "Scroll down",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(2),
            },
            {
              bind: "k",
              title: "Scroll up",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(-2),
            },
            {
              bind: "up",
              title: "Scroll up",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(-2),
            },
            {
              bind: "pagedown",
              title: "Page down",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(12),
            },
            {
              bind: "ctrl+d",
              title: "Page down",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(12),
            },
            {
              bind: "pageup",
              title: "Page up",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(-12),
            },
            {
              bind: "ctrl+u",
              title: "Page up",
              group: "Antigravity",
              run: () => scroll?.scrollBy?.(-12),
            },
            {
              bind: "g",
              title: "Scroll to top",
              group: "Antigravity",
              run: () => scroll?.scrollTo?.(0),
            },
            {
              bind: "shift+g",
              title: "Scroll to bottom",
              group: "Antigravity",
              run: () => scroll?.scrollTo?.(scroll?.scrollHeight ?? 999_999),
            },
          ],
        }));

        return (
          <Show when={isActivePanel()}>
            <box
              flexDirection="column"
              flexGrow={1}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              gap={1}
              onMouseUp={() => input.focus()}
            >
              <box flexDirection="row" justifyContent="space-between" gap={1} flexShrink={0}>
                <text fg={ctx.theme.text.base}>
                  {`◈ agy trace (${allRuns().length} ${allRuns().length === 1 ? "run" : "runs"})`}
                </text>
                <box flexDirection="row" gap={2} flexShrink={0}>
                  <text fg={ctx.theme.text.muted} onMouseUp={() => setAllExpanded(true)}>
                    [e expand]
                  </text>
                  <text fg={ctx.theme.text.muted} onMouseUp={() => setAllExpanded(false)}>
                    [c collapse]
                  </text>
                  <text fg={ctx.theme.text.muted} onMouseUp={() => input.toggleFullscreen()}>
                    {input.presentation === "fullscreen" ? "[f split]" : "[f fullscreen]"}
                  </text>
                  <text fg={ctx.theme.text.muted} onMouseUp={() => input.close()}>
                    [q/esc close]
                  </text>
                </box>
              </box>

              <Show
                when={allRuns().length > 0}
                fallback={
                  <text fg={ctx.theme.text.muted}>
                    No agy runs in this session yet.
                  </text>
                }
              >
                <scrollbox
                  flexGrow={1}
                  ref={(el: unknown) => {
                    scroll = el as typeof scroll;
                  }}
                >
                  <box flexDirection="column" gap={1}>
                    <For each={allRuns()}>
                      {(run, index) => {
                        const duration = createMemo(() =>
                          formatDuration(run.startedAt, run.completedAt ?? now()),
                        );
                        const expanded = createMemo(() => isExpanded(run));
                        const selected = createMemo(() => index() === selectedIndex());
                        const pending = createMemo(() => pendingControl()[run.id]);
                        const statusGlyph = createMemo(() =>
                          isRunningStatus(run.status)
                            ? "●"
                            : run.status === "completed"
                              ? "✓"
                              : run.status === "cancelled"
                                ? "⊘"
                                : "✗",
                        );
                        const statusLabel = createMemo(() => {
                          const p = pending();
                          if (p === "cancelling") return "cancelling…";
                          if (p === "backgrounding") return "backgrounding…";
                          return run.background ? `${run.status} (bg)` : run.status;
                        });
                        return (
                          <box
                            flexDirection="column"
                            border={["left"]}
                            borderColor={
                              selected() ? ctx.theme.text.base : ctx.theme.border.base
                            }
                            backgroundColor={ctx.theme.background.raised.base}
                            paddingLeft={2}
                            paddingRight={2}
                            paddingTop={1}
                            paddingBottom={1}
                            gap={expanded() ? 1 : 0}
                          >
                            <box flexDirection="column">
                              <box
                                flexDirection="row"
                                justifyContent="space-between"
                                gap={2}
                              >
                                <box
                                  flexGrow={1}
                                  onMouseUp={() => {
                                    setSelectedIndex(index());
                                    toggleRun(run);
                                  }}
                                >
                                  <text
                                    fg={
                                      run.status === "error"
                                        ? ctx.theme.text.feedback.error.base
                                        : run.status === "cancelled"
                                          ? ctx.theme.text.feedback.warning.base
                                          : ctx.theme.text.base
                                    }
                                    wrapMode="none"
                                    truncate
                                  >
                                    {`${expanded() ? "▾" : "▸"} ${statusGlyph()} ${statusLabel()}${run.model ? ` · ${run.model}` : ""}${duration() ? ` · ${duration()}` : ""}${run.toolCallCount > 0 ? ` · ${run.toolCallCount} ${run.toolCallCount === 1 ? "step" : "steps"}` : ""}${run.agySessionId ? ` · ${shortId(run.agySessionId)}` : ""}`}
                                  </text>
                                </box>
                                <Show when={isRunningStatus(run.status)}>
                                  <box flexDirection="row" gap={2} flexShrink={0}>
                                    <Show when={!run.background && !pending()}>
                                      <text
                                        fg={ctx.theme.text.muted}
                                        onMouseUp={() => {
                                          setSelectedIndex(index());
                                          backgroundRun(run);
                                        }}
                                      >
                                        [b bg]
                                      </text>
                                    </Show>
                                    <Show when={pending() !== "cancelling"}>
                                      <text
                                        fg={ctx.theme.text.feedback.warning.base}
                                        onMouseUp={() => {
                                          setSelectedIndex(index());
                                          cancelRun(run);
                                        }}
                                      >
                                        [x cancel]
                                      </text>
                                    </Show>
                                  </box>
                                </Show>
                              </box>
                              <Show when={!expanded() && run.prompt}>
                                <box
                                  onMouseUp={() => {
                                    setSelectedIndex(index());
                                    toggleRun(run);
                                  }}
                                >
                                  <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
                                    {`  ${truncateLine(run.prompt, 120)}`}
                                  </text>
                                </box>
                              </Show>
                            </box>

                            <Show when={expanded()}>
                              <box flexDirection="column" gap={1}>
                                <box flexDirection="column">
                                  <Show when={run.background}>
                                    <text fg={ctx.theme.text.muted}>
                                      {`job_id: ${run.id}`}
                                    </text>
                                  </Show>
                                  <Show when={run.agySessionId}>
                                    {(sid) => (
                                      <text fg={ctx.theme.text.muted}>
                                        {`session_id: ${sid()}`}
                                      </text>
                                    )}
                                  </Show>
                                  <Show when={run.prompt}>
                                    <text fg={ctx.theme.text.muted} wrapMode="word">
                                      {`prompt: ${truncateLine(run.prompt, 240)}`}
                                    </text>
                                  </Show>
                                </box>

                                <Show when={run.plan.length > 0}>
                                  <box flexDirection="column">
                                    <text fg={ctx.theme.text.base}>Plan</text>
                                    <For each={run.plan}>
                                      {(entry) => (
                                        <text fg={ctx.theme.text.muted} wrapMode="word">
                                          {`  ${planIcon(entry.status)} ${entry.content}`}
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>

                                <Show
                                  when={run.toolCalls.length > 0}
                                  fallback={
                                    <Show when={!isRunningStatus(run.status)}>
                                      <text fg={ctx.theme.text.muted}>
                                        (no step trace recorded for this run)
                                      </text>
                                    </Show>
                                  }
                                >
                                  {(() => {
                                    const collapsed = createMemo(() =>
                                      collapseConsecutiveSteps(run.toolCalls),
                                    );
                                    const showingAll = createMemo(() =>
                                      Boolean(showAllStepsByRun()[run.id]),
                                    );
                                    const hiddenEntries = createMemo(() =>
                                      showingAll()
                                        ? []
                                        : collapsed().slice(
                                            0,
                                            Math.max(
                                              0,
                                              collapsed().length - RECENT_STEPS_LIMIT,
                                            ),
                                          ),
                                    );
                                    const hiddenStepCount = createMemo(() =>
                                      hiddenEntries().reduce(
                                        (sum, entry) => sum + entry.count,
                                        0,
                                      ),
                                    );
                                    const visibleSteps = createMemo(() =>
                                      showingAll()
                                        ? collapsed()
                                        : collapsed().slice(-RECENT_STEPS_LIMIT),
                                    );
                                    const hasMore = createMemo(
                                      () => collapsed().length > RECENT_STEPS_LIMIT,
                                    );
                                    return (
                                      <box flexDirection="column">
                                        <text fg={ctx.theme.text.base}>
                                          {hiddenStepCount() > 0
                                            ? `Steps (latest ${RECENT_STEPS_LIMIT} of ${collapsed().length}${collapsed().length < run.toolCalls.length ? ` · ${run.toolCalls.length} total` : ""} · newest at bottom)`
                                            : `Steps (${run.toolCalls.length} · newest at bottom)`}
                                        </text>
                                        <Show when={hasMore()}>
                                          <text
                                            fg={ctx.theme.text.muted}
                                            onMouseUp={() => toggleAllSteps(run.id)}
                                          >
                                            {hiddenStepCount() > 0
                                              ? `  ... [show ${hiddenStepCount()} earlier ${hiddenStepCount() === 1 ? "step" : "steps"}] ...`
                                              : `  ... [show latest ${RECENT_STEPS_LIMIT} only] ...`}
                                          </text>
                                        </Show>
                                        <For each={visibleSteps()}>
                                          {(entry) => (
                                            <text
                                              fg={
                                                entry.isError
                                                  ? ctx.theme.text.feedback.error.base
                                                  : ctx.theme.text.muted
                                              }
                                              wrapMode="word"
                                            >
                                              {`  ${entry.icon} ${entry.text}${entry.count > 1 ? ` (×${entry.count})` : ""}`}
                                            </text>
                                          )}
                                        </For>
                                      </box>
                                    );
                                  })()}
                                </Show>

                                <Show when={run.latestThought}>
                                  {(thought) => (
                                    <text fg={ctx.theme.text.muted} wrapMode="word">
                                      {`thought: ${thought()}`}
                                    </text>
                                  )}
                                </Show>

                                <Show when={run.latestText && isRunningStatus(run.status)}>
                                  <text fg={ctx.theme.text.base} wrapMode="word">
                                    {`output: ${run.latestText}`}
                                  </text>
                                </Show>

                                <Show when={run.errorMessage && run.status === "error"}>
                                  {(err) => (
                                    <text
                                      fg={ctx.theme.text.feedback.error.base}
                                      wrapMode="word"
                                    >
                                      {`error: ${err()}`}
                                    </text>
                                  )}
                                </Show>
                              </box>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                </scrollbox>
              </Show>

              <text fg={ctx.theme.text.muted} flexShrink={0} wrapMode="none" truncate>
                tab select · enter toggle · b background · x cancel · s all steps · e/c expand/collapse · j/k scroll
              </text>
            </box>
          </Show>
        );
      },
    });

    return () => {
      disposeFooterStatus();
      disposePanel();
    };
  },
});
