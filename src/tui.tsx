/** @jsxImportSource @opentui/solid */
// OpenCode 2.0 TUI plugin for `opencode-agy-acp`.
//
// Renders live-streaming `agy acp` steps from `toolCtx.progress(...)` metadata:
// 1. `session.composer.top`: compact live activity feed while `agy` is running.
// 2. `session.panel`: scrollable full step trace for running and completed runs.

import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { AgyPlanEntry, AgyToolCallSummary } from "./index.ts";

const PANEL_NAME = "agy-trace";

interface AgyRunView {
  readonly id: string;
  readonly status: "streaming" | "running" | "completed" | "error";
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

function extractAgyRuns(messages: readonly unknown[]): AgyRunView[] {
  const runs: AgyRunView[] = [];
  for (const rawMessage of messages) {
    const msg = asRecord(rawMessage);
    if (msg?.type !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const rawPart of msg.content) {
      const part = asRecord(rawPart);
      if (part?.type !== "tool" || part.name !== "agy") continue;
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
      const input = asRecord(state?.input);
      const meta = asRecord(state?.metadata) ?? {};
      const toolCalls = parseToolCalls(meta.toolCalls);
      const plan = parsePlan(meta.plan);
      const errorObj = asRecord(state?.error);

      runs.push({
        id: asString(part.id) ?? `agy-${runs.length + 1}`,
        status,
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
    }
  }
  return runs;
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

function stepIcon(status: string | undefined): string {
  const st = (status ?? "").toLowerCase();
  if (st === "completed" || st === "done") return "✓";
  if (st === "failed" || st === "error" || st === "cancelled") return "✗";
  return "›";
}

function planIcon(status: string | undefined): string {
  const st = (status ?? "").toLowerCase();
  if (st === "completed" || st === "done") return "✓";
  if (st === "in_progress" || st === "running") return "●";
  return "○";
}

function isStepError(status: string | undefined): boolean {
  const st = (status ?? "").toLowerCase();
  return st === "failed" || st === "error" || st === "cancelled";
}

export default Plugin.define({
  id: "opencode-agy-acp",
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

    const disposeComposerTop = ctx.ui.slot({
      append: "session.composer.top",
      render(input) {
        const runningRuns = createMemo(() =>
          extractAgyRuns(ctx.data.session.message.list(input.sessionID)).filter(
            (run) => run.status === "running" || run.status === "streaming",
          ),
        );

        const [now, setNow] = createSignal(Date.now());
        createEffect(() => {
          if (runningRuns().length === 0) return;
          setNow(Date.now());
          const timer = setInterval(() => setNow(Date.now()), 1000);
          onCleanup(() => clearInterval(timer));
        });

        return (
          <Show when={runningRuns().length > 0}>
            <box
              flexDirection="column"
              flexShrink={0}
              border={["left"]}
              borderColor={ctx.theme.border.base}
              backgroundColor={ctx.theme.background.raised.base}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              gap={1}
              onMouseUp={() => ctx.ui.panel.open(PANEL_NAME, { presentation: "panel" })}
            >
              <For each={runningRuns()}>
                {(run) => {
                  const elapsed = createMemo(() => formatDuration(run.startedAt, now()));
                  const recentSteps = createMemo(() => run.toolCalls.slice(-4));
                  const activePlan = createMemo(() =>
                    run.plan
                      .filter((p) => {
                        const st = (p.status ?? "").toLowerCase();
                        return st !== "completed" && st !== "done";
                      })
                      .slice(0, 2),
                  );
                  const previewLine = createMemo(() => run.latestText ?? run.latestThought);

                  return (
                    <box flexDirection="column">
                      <box flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={ctx.theme.text.base} wrapMode="none" truncate>
                          {`◈ agy${run.model ? ` · ${run.model}` : ""}${run.agySessionId ? ` · ${shortId(run.agySessionId)}` : ""}${run.toolCallCount > 0 ? ` · ${run.toolCallCount} ${run.toolCallCount === 1 ? "step" : "steps"}` : ""}${elapsed() ? ` · ${elapsed()}` : ""}`}
                        </text>
                        <text fg={ctx.theme.text.muted} flexShrink={0}>
                          click for trace
                        </text>
                      </box>

                      <Show when={activePlan().length > 0}>
                        <box flexDirection="column" paddingLeft={2}>
                          <For each={activePlan()}>
                            {(entry) => (
                              <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
                                {`${planIcon(entry.status)} ${entry.content}`}
                              </text>
                            )}
                          </For>
                        </box>
                      </Show>

                      <Show
                        when={recentSteps().length > 0}
                        fallback={
                          <box paddingLeft={2}>
                            <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
                              {`› ${run.currentActivity ?? "Starting…"}`}
                            </text>
                          </box>
                        }
                      >
                        <box flexDirection="column" paddingLeft={2}>
                          <For each={recentSteps()}>
                            {(step) => (
                              <text
                                fg={
                                  isStepError(step.status)
                                    ? ctx.theme.text.feedback.error.base
                                    : ctx.theme.text.muted
                                }
                                wrapMode="none"
                                truncate
                              >
                                {`${stepIcon(step.status)} ${step.title}${step.detail ? ` — ${step.detail}` : ""}`}
                              </text>
                            )}
                          </For>
                        </box>
                      </Show>

                      <Show when={previewLine()}>
                        {(line) => (
                          <box paddingLeft={2}>
                            <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
                              {`… ${line()}`}
                            </text>
                          </box>
                        )}
                      </Show>
                    </box>
                  );
                }}
              </For>
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
          () => isActivePanel() && (input.presentation === "fullscreen" || input.focused === true),
        );
        const allRuns = createMemo(() =>
          extractAgyRuns(ctx.data.session.message.list(input.sessionID)).reverse(),
        );
        const hasRunning = createMemo(() =>
          allRuns().some((r) => r.status === "running" || r.status === "streaming"),
        );

        let scroll: { scrollBy?: (delta: number) => void; scrollTo?: (y: number) => void; scrollHeight?: number } | undefined;

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
                <scrollbox flexGrow={1} ref={(el: unknown) => { scroll = el as typeof scroll; }}>
                  <box flexDirection="column" gap={1}>
                    <For each={allRuns()}>
                      {(run) => {
                        const duration = createMemo(() =>
                          formatDuration(run.startedAt, run.completedAt ?? now()),
                        );
                        return (
                          <box
                            flexDirection="column"
                            border={["left"]}
                            borderColor={ctx.theme.border.base}
                            backgroundColor={ctx.theme.background.raised.base}
                            paddingLeft={2}
                            paddingRight={2}
                            paddingTop={1}
                            paddingBottom={1}
                            gap={1}
                          >
                            <box flexDirection="column">
                              <text
                                fg={
                                  run.status === "error"
                                    ? ctx.theme.text.feedback.error.base
                                    : ctx.theme.text.base
                                }
                              >
                                {`${run.status === "running" || run.status === "streaming" ? "●" : run.status === "completed" ? "✓" : "✗"} ${run.status}${run.model ? ` · ${run.model}` : ""}${duration() ? ` · ${duration()}` : ""}${run.toolCallCount > 0 ? ` · ${run.toolCallCount} ${run.toolCallCount === 1 ? "step" : "steps"}` : ""}`}
                              </text>
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

                            <Show when={run.toolCalls.length > 0}>
                              <box flexDirection="column">
                                <text fg={ctx.theme.text.base}>Steps</text>
                                <For each={run.toolCalls}>
                                  {(step) => (
                                    <text
                                      fg={
                                        isStepError(step.status)
                                          ? ctx.theme.text.feedback.error.base
                                          : ctx.theme.text.muted
                                      }
                                      wrapMode="word"
                                    >
                                      {`  ${stepIcon(step.status)} ${step.title}${step.detail ? ` — ${step.detail}` : ""}`}
                                    </text>
                                  )}
                                </For>
                              </box>
                            </Show>

                            <Show when={run.latestThought}>
                              {(thought) => (
                                <text fg={ctx.theme.text.muted} wrapMode="word">
                                  {`thought: ${thought()}`}
                                </text>
                              )}
                            </Show>

                            <Show when={run.latestText && (run.status === "running" || run.status === "streaming")}>
                              <text fg={ctx.theme.text.base} wrapMode="word">
                                {`output: ${run.latestText}`}
                              </text>
                            </Show>

                            <Show when={run.errorMessage}>
                              {(err) => (
                                <text fg={ctx.theme.text.feedback.error.base} wrapMode="word">
                                  {`error: ${err()}`}
                                </text>
                              )}
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                </scrollbox>
              </Show>
            </box>
          </Show>
        );
      },
    });

    return () => {
      disposeComposerTop();
      disposePanel();
    };
  },
});
