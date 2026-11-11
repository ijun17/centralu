# Apps: tools built where they are used

An app is a small program that lives with a project: a person uses it through its screen, and
agents call the same tools as functions. There is one code path for both. This document describes
what the code does (M4, [plans/apps-plan.md](../plans/apps-plan.md) has the reasoning and the history);
where a piece is still arriving, it says so.

An app is an **MCP server**, and its screens are **MCP Apps** views (`ui://` resources, ext-apps
2.x). Centralu has no format of its own for either: an app built for another host runs here, and an
app built here is a standard MCP server. What Centralu adds on top is listed in [What is standard and what is Centralu's](#what-is-standard-and-what-is-centralus).

Code: runtime `packages/agent-host/src/apps/external/`, view hosting `packages/agent-host/src/views/`,
session attachment `sessions/session-apps.ts`, inline views `inline-views.ts`, template
`packages/agent-host/app-template/`, UI `packages/ui/src/features/{app-frame,pinned-app}/` and
`session/InlineView.tsx`. These are the only apps: the compiled built-in app framework and its one app,
the control rail (#81), were removed in #372 (decided in #97). Security reasoning: [security-boundaries/](../security-boundaries/README.md).

## What is standard and what is Centralu's

| Layer | What | With an app built for another host |
|---|---|---|
| Standard | MCP server; `ui://` resources (`text/html;profile=mcp-app`) and `_meta.ui.resourceUri`; `_meta.ui.visibility`; `_meta.ui.csp` and `permissions`; the view lifecycle (tool-input, tool-result, tool-cancelled, resource-teardown, size, host context); the sandbox proxy | Works |
| Standard, inline | A view under the tool card that called it | **Works: `e2e/public-apps.spec.ts`**, two official examples, unmodified |
| Centralu's way, within the standard | The manifest; the pinned view (the host calls `home`); attaching apps to sessions as `app-<id>`; trust; run records; `check`; the builder | The pinned view needs only a `home` tool with a view in the manifest (not covered by the compatibility test). The rest is invisible to the app |
| Centralu extension | `centralu/notifications/changed`; the fd 3 broker and `_meta["centralu/runId"]`; `run_status`; `centralu.fontScale`; `centralu.variables` (signal, scrollbar) | Does not apply: such an app ignores the notification, so an open view shows what it last read, and it has no broker |

So "an app for another host runs as it is" holds **for the inline surface**. Keeping open views
current and the broker work only for apps built from our template. In the other direction, a
template app is a standard MCP server with a standard view: another host ignores the notification,
and `centralu.agent()` fails with "the broker pipe (fd 3) is not open". Running a template app in
another host has not been tested.

## Not there yet

- The manifest's `csp` field is not read; the per-app origin is chosen only in the manifest.
- Resource templates are not accepted by the spoof check; a Claude subagent's app calls get no
  inline view.
- The Codex path is unverified by a run ([attaching.md](attaching.md#claude-and-codex)), and so is `run_agent` on Codex (its `outputSchema`
  is checked against the app-server protocol and a fake adapter only). fd 3 on Windows (spike
  S-5, [broker-and-rpcs.md](broker-and-rpcs.md#the-broker-agents-other-apps-host-data)) passes the broker test suites in the Windows CI job with Node apps; a Python app, and
  any app in the packaged Windows app, have not been tried.
- The broker answers only while the app handles a call, except `busy` and `notify`: an app cannot
  run an agent, call an app or read host data by itself (a timer, a watcher). The host data list has
  two names.
- Attaching another project's app ([other-projects-apps.md](other-projects-apps.md)) is a project session's: the Assistant, a worktree
  manager and a coordinator cannot. Codex gets an attached app only from its next turn, so the
  person has to send another message for the model to use it.
- Export (plan E-2) and sharing through a team server are not built: an app is shared by sending
  its folder or a zip of it, or by committing a project app.
- App links arrive on macOS only, and have been exercised by hand, not in CI ([handing-over.md](handing-over.md#app-links-e-4)). An https
  host given by name is not checked for resolving to a private address.
- Dragging an item out of a view ([view-theme-layout-drag.md](view-theme-layout-drag.md#dragging-an-item-out-of-a-view-308)) has run only in Playwright's Chromium and WebKit, not in the
  packaged app's WKWebView or in WebView2; the end point's coordinates there are taken from those
  engines' measurements. During such a drag the page hears nothing, so no drop target lights up.

## The files

| File | What it holds |
|---|---|
| [what-an-app-is.md](what-an-app-is.md) | What an app is, the manifest (`centralu.app.json`), where apps live |
| [trust-lifecycle-calls.md](trust-lifecycle-calls.md) | Trust, lifecycle, the one call path (`ExternalApps.call`), tool visibility, run records |
| [views.md](views.md) | Where a view appears: inline, pinned, keeping open views current, how a view is hosted |
| [view-theme-layout-drag.md](view-theme-layout-drag.md) | The theme in a view, narrow first, dragging an item out of a view |
| [build-loop.md](build-loop.md) | The build loop |
| [attaching.md](attaching.md) | Attaching apps to sessions: which session gets which apps, Claude and Codex, long calls and cancellation |
| [other-projects-apps.md](other-projects-apps.md) | Another project's apps, on demand |
| [broker-and-rpcs.md](broker-and-rpcs.md) | The broker (agents, other apps, host data), RPCs and events |
| [handing-over.md](handing-over.md) | Handing apps over: import, versions, app links |
