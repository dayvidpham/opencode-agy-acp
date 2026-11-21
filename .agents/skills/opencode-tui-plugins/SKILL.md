---
name: opencode-tui-plugins
description: Extending the OpenCode 2.x Terminal UI (TUI) with `./tui` plugins, slots (`session.composer.top`, `session.panel`, sidebar), live tool progress streaming, OpenTUI JSX constraints, and keymap layers/modes (slash commands, command palette, and panel keyboard navigation). Use when building or debugging OpenCode TUI plugin extensions.
---

# Extending the OpenCode 2.x TUI

Distilled conventions and gotchas for writing zero-dependency OpenCode 2.x TUI plugins (verified against OpenCode 2.3.2).

## 1. Packaging & Runtime Loading

- Export `"./tui"` in `package.json`:
  ```json
  {
    "exports": {
      ".": "./src/index.ts",
      "./tui": "./src/tui.tsx"
    }
  }
  ```
- Put `/** @jsxImportSource @opentui/solid */` on **line 1** of `.tsx` entrypoints so Bun compiles JSX against `@opentui/solid` without a local `tsconfig.json` or npm dependencies.
- OpenCode's runtime plugin loader automatically provides `@opencode/plugin/tui`, `@opentui/solid`, `@opentui/core`, and `solid-js`.
- Export a default `Plugin.define({ id, setup(ctx) { ... } })` from `@opencode/plugin/tui`. Return a cleanup function that disposes registered slots/resources.
- Local `./tui` plugins hot-reload automatically on file save via OpenCode's source watcher.

## 2. Why Custom Tools Don't Stream Inline (and the Pattern That Works)

- In OpenCode's TUI (`packages/tui/src/routes/session/index.tsx`), `ToolPart` is a hardcoded `<Switch>` over built-in tools (`shell`, `read`, `edit`, `subagent`, `execute`, etc.). All plugin tools fall back to `GenericTool`.
- `GenericTool` **ignores `props.metadata`** and hides `output` while `state.status === "running"`, showing only a spinner next to the tool name.
- **No custom IPC is needed to stream live steps:**
  1. In the server plugin, call `toolCtx.progress({ ... })` during tool execution. OpenCode syncs that object into `part.state.metadata` in the TUI's reactive store.
  2. In the `./tui` plugin, reactively read `ctx.data.session.message.list(input.sessionID)` inside a `createMemo`, filter for assistant `part.type === "tool" && part.name === "<tool>"`, and render `part.state.metadata`.
- Flush `toolCtx.progress(...)` immediately on structural transitions (tool calls, plan updates) and throttle high-frequency text/thought chunks (~150ms).

## 3. TUI Slots (`ctx.ui.slot`)

Each slot claim takes `{ render }` plus **exactly one** placement key (`prepend`, `append`, `before`, `after`, `replace`).

Available slots (`SlotMap` in `packages/plugin/src/tui/context.ts`):
- **`session.composer.top`** (`{ sessionID }`): Main session body, directly above the prompt box. Ideal for a compact live activity feed wrapped in `<Show when={runningRuns().length > 0}>` so it only occupies space while active.
- **`session.panel`** (`PanelInput`): Split or fullscreen pane inside the session view. Opened via `ctx.ui.panel.open(PANEL_NAME, { presentation: "panel" | "fullscreen" })`. Always guard rendering with `<Show when={input.name === PANEL_NAME}>` because all panel contributions share the `session.panel` slot.
  - `PanelInput` provides: `name`, `sessionID`, `width`, `presentation`, `focused`, `focus()`, `close()`, `toggleFullscreen()`.
- **`sidebar.content`** / **`sidebar.footer`** (`{ sessionID }`): Session sidebar.
- **`prompt.footer`** / **`prompt.footer.status`** / **`prompt.footer.file`**, **`home.footer`** / **`home.footer.status`**, **`app`**.

### OpenTUI Rendering Rules
- **Never render bare text or numbers** directly under `<box>`, `<Show>`, `<For>`, or fragments. Wrap all text in `<text>...</text>` — otherwise OpenCode's `PluginOutput` throws `"rendered bare text; wrap it in <text>"` and trips the plugin error boundary.
- Use verified `ctx.theme` tokens:
  - Text: `ctx.theme.text.base`, `ctx.theme.text.muted`, `ctx.theme.text.feedback.error.base`, `ctx.theme.text.feedback.warning.base`
  - Surfaces & borders: `ctx.theme.background.base`, `ctx.theme.background.raised.base`, `ctx.theme.border.base`
- Slot `input` props are reactive via `mergeProps`; read `input.sessionID`, `input.name`, `input.focused`, etc. inside `createMemo` or JSX expressions, not eagerly once at the top of `render`.

## 4. Keymap Layers, Modes, Slash Commands, and Panel Navigation

OpenCode uses a mutually exclusive **mode stack** (`keymap.mode.push(...)`). A `ctx.keymap.layer(...)` only activates when its `mode` matches the top of the stack, unless `mode: "global"` opts out:

| Mode | When active | Use for |
| --- | --- | --- |
| `"global"` | Always (opts out of mode filtering) | Slash commands (`slash: { name }`) and command-palette entries (`palette: true`) |
| `"base"` *(default)* | Normal session/home view | Panel/view shortcuts that must not hijack dialogs, menus, or autocomplete |
| `"autocomplete"` | `/` or `@` popup is open | Host autocomplete navigation |
| `"modal"` | Dialog or `Ctrl+P` palette is open | Dialog controls |
| `"composer"` / `"menu"` / `"form"` | Bottom drawer, context menu, or form | Overlay-specific controls |

### Slash Commands & Command Palette
Must use **`mode: "global"`** — typing `/` pushes `"autocomplete"` and `Ctrl+P` pushes `"modal"`, which hides `"base"`-mode layers:
```tsx
ctx.keymap.layer(() => ({
  mode: "global",
  commands: [
    {
      id: "my-plugin.panel.toggle",
      title: "Toggle trace panel",
      group: "MyPlugin",
      palette: true,
      slash: { name: "my-trace" },
      run: togglePanel,
    },
  ],
}));
```

### Keyboard Navigation Inside `session.panel`
Register a layer inside the `session.panel` slot's `render(input)` (disposed automatically with the component owner) using default `"base"` mode and gated on focus:
```tsx
const isActivePanel = createMemo(() => input.name === PANEL_NAME);
const focused = createMemo(
  () => isActivePanel() && (input.presentation === "fullscreen" || input.focused === true),
);

let scroll: { scrollBy?: (d: number) => void; scrollTo?: (y: number) => void; scrollHeight?: number } | undefined;

ctx.keymap.layer(() => ({
  enabled: () => focused(),
  priority: 10,
  commands: [
    { bind: "f", title: "Toggle fullscreen", run: () => input.toggleFullscreen() },
    { bind: "q", title: "Close panel", run: () => input.close() },
    { bind: "escape", title: "Close panel", run: () => input.close() },
    { bind: "j", title: "Scroll down", run: () => scroll?.scrollBy?.(2) },
    { bind: "down", title: "Scroll down", run: () => scroll?.scrollBy?.(2) },
    { bind: "k", title: "Scroll up", run: () => scroll?.scrollBy?.(-2) },
    { bind: "up", title: "Scroll up", run: () => scroll?.scrollBy?.(-2) },
    { bind: "pagedown", title: "Page down", run: () => scroll?.scrollBy?.(12) },
    { bind: "ctrl+d", title: "Page down", run: () => scroll?.scrollBy?.(12) },
    { bind: "pageup", title: "Page up", run: () => scroll?.scrollBy?.(-12) },
    { bind: "ctrl+u", title: "Page up", run: () => scroll?.scrollBy?.(-12) },
    { bind: "g", title: "Top", run: () => scroll?.scrollTo?.(0) },
    { bind: "shift+g", title: "Bottom", run: () => scroll?.scrollTo?.(scroll?.scrollHeight ?? 999_999) },
  ],
}));
```
Attach `onMouseUp={() => input.focus()}` on the panel's root `<box>` and `ref={(el) => { scroll = el; }}` on `<scrollbox>`.

## 5. Debugging Checklist

1. **Confirm server detected `./tui`:**
   ```bash
   opencode api GET "/api/plugin?directory=$(pwd)"
   ```
   Look for `"features": { "server": true, "tui": true }` and `"state": { "status": "active" }`.
2. **Check TUI plugin reconciliation & crashes:**
   - Run `/plugins` inside OpenCode to see TUI plugin status and any setup/render errors.
   - Check `~/.local/share/opencode/log/opencode.log` for `component=plugin` entries (`plugin reconciliation completed`).
3. **Slash command missing?** Confirm `mode: "global"` is set on the `ctx.keymap.layer(...)` registering the command.
