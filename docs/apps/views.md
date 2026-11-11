# Where a view appears

MCP Apps views have no state: every view is an instance made by one tool call, and the standard
leaves restoring state to a future extension. So an app's state lives in its server and its data
folder, and a view is a window onto it.

## Inline, under the tool card (standard)

When a session's agent calls an app tool that declares `_meta.ui.resourceUri`, the view opens under
that call's card in the conversation. This is the standard's own use of a view, and the surface
where apps built for other hosts work unmodified. `e2e/public-apps.spec.ts` runs two official
ext-apps examples here, from their published npm packages, with a minimal manifest.

- **Which card**: Claude's CLI puts the card id in `_meta["claudecode/toolUseId"]` of every MCP call
  (read from the CLI binary in SDK 0.3.263). A Codex bridge call carries no id, so the host pairs
  Codex's `item/started` (`mcpToolCall`) with the bridged call by (server, tool, arguments with
  sorted keys), waiting up to 5 s for whichever arrives second. A call with no card gets no view (a
  Claude subagent's call, for one); the call itself runs unchanged.
- **Spoof check**: the view opens only if the URI the tool declares is in its app's
  `resources/list`. If the result then points at a different view, the view closes and the refusal
  is shown and logged. Resource templates are not accepted.
- **Order**: tool-input when the call starts, then tool-result or tool-cancelled when it ends.
- **Limits**: at most 3 live views per conversation (host and UI agree); a fourth closes the one
  opened earliest. A view scrolling far out of the virtualised conversation first gets
  `ui/resource-teardown`, then folds into a placeholder.
- **Reopen** does not call the tool again. The host keeps each call's input and result in memory
  (256K characters per call, 20 calls per conversation, 8M characters in all) and replays them to a
  new instance. After a host restart, or when a result was too large to keep, the placeholder offers
  only "Open app", the pinned view.
- **Pin** opens the app's pinned view.
- **`ui/message`** from an inline view asks first (*<app> wants to send this to this conversation*,
  Cancel or Send). Sent text goes only to that conversation, is shown as "<app> app ⤷", and reaches
  the agent framed as the app's text (security-boundaries/untrusted-text.md "Text an app sends").

## Pinned, in the main area (Centralu's way, within the standard)

Apps stand in the sidebar under their project. A **root app** is its project (#1141): it has no row of
its own; the project's line carries an app mark (dimmed, with the reason in its label, when the app
cannot run; lit while its screen shows or its view asks something), and the mark and "Open as app" in
the project's menu open it. The project's line is dragged onto the grid or its project screen as an
app row is. Its sessions (its builder, its agents) are the project's sessions. The
"Your apps" section is gone, which also settles #732's crowded bottom; a user-folder app still listed
(a linked machine on a build from before #1141, or one this host could not move into a project)
stands in "Other apps" above the bottom row, which is drawn only while there is one. Opening one
makes the host call the manifest's `home` tool, as a `view` caller, and show the result's view in
the main area. A host calling a tool is within the standard, and the view is still born from a tool
call.

A project app's sessions (its builder, the agents its `run_agent` started) belong to the
project and stand indented under the app's row, with their session menus and badges (#591).
Sessions of a removed project app return to the project's ordinary session list. A user-folder
app's sessions have no project and stand indented under its row in "Other apps". An app row says
"asks you" for an approval or a pending question, including a question from its view; a completed
turn awaiting another message does not set that mark. A session with no project that no listed
app claims (a coordinator the control app left behind, #372; a session of a user-folder app since
removed) has no sidebar row. Search, the command palette and the inbox still reach it. The
"No app" list that used to hang under the Assistant
row and catch all of these is gone (#372 follow-up): nothing stands under the Assistant.

- `home` must declare a `ui://` view and be visible to `app`. Otherwise opening is refused **before
  anything is called**, so nobody sees the app's state change behind a screen that never appeared.
- Going to a session and back keeps the same document (hidden, not unloaded). Every way a view goes
  away sends teardown first. A hidden view is moved out of the window and made `inert`, never put
  in `display: none` or `visibility: hidden`: in WKWebView a frame hidden either way and shown again
  stops drawing the native scrollbars inside the app's document, leaving an empty gutter (#309). A view that holds focus when it is hidden lets go of it:
  WebKit keeps focus inside a frame that turns inert, and the keys went on into a view nobody could
  see (#115). When Centralu starts again, the app that was on screen reopens (the
  host calls `home` again).
- While the app starts, a skeleton; if it fails, the reason and Restart. Restart waits until the
  host has stopped the app before opening again.
- The Runs panel ([trust-lifecycle-calls.md](trust-lifecycle-calls.md#run-records)) opens beside the view.
- **On its project's screen** (product-spec §5.5) the pinned view stands in the app's panel. It is
  the same entry, instance and frame as the app view's: the frame never moves in the document (a
  moved iframe loses its document), the view is laid over the panel's slot and only its style
  changes (`pinned-app/slots.ts`). In a panel the view has no header; the panel's Open goes to the
  app view, and removing the panel closes the view, teardown first. The app's sidebar row dropped on
  the screen adds its panel where it lands. Project screens start empty; apps never appear automatically. While anything is dragged, the panel lays a
  transparent cover over the view (`pinned-app/dragShield.tsx`, #296), and the view stays in sight:
  in WebKit a drag goes into a frame whatever its pointer-events say, and the row or panel would
  land in the app instead of beside it. The cover is the panel's child in React's tree, portalled
  into the view, so the panel's own drag handlers hear the drag; it goes on the drag's drop or
  end, or when the drag leaves the window. The panel's slot takes the view's place in the keyboard order: Tab
  from the panel's header goes into the view, and back out to the header.
- **On the grid** (product-spec §5.4, #288) an app placed there by hand gets **a view of its own**:
  the same hosting (opened by `home`, laid over the panel's slot, hidden rather than unloaded on
  another screen, teardown first when the panel is removed), but a separate entry and instance
  from the pinned view above, so the same app can stand on the grid and on its project screen at
  once, each keeping its document, with one app process behind both. Each grid view costs one
  instance and one frame; nothing caps their number.
- **An app panel's span on the grid** (#306): columns × rows of grid cells (a session panel is
  1 × 1). The person sets it — for one placement from the panel's top bar ("2×1", a cell picker;
  kept on the placement, `GridPanel.span`), for the app in Settings → Apps — and the app may
  recommend one in its manifest (`view.span`, the app list's `span`). The first that is set wins:
  placement, Settings, the app, 1 × 1. The grid clamps a span the window cannot hold and says so on
  the button; the view is laid over the larger slot like any other (product-spec §5.4). So a view
  must work at whatever size it gets: the recommendation is a hint, not a promise.
- **`ui/message`** from a pinned view asks the person which session to send it to. Nothing is sent
  before a choice, and cancelling tells the view it was not sent. Once picked, it goes the inline
  view's way (`apps.viewMessage`): stored as the app's message, and framed as the app's text for the
  agent, saying it came from outside that conversation.

## Keeping open views current (Centralu extension)

In the standard, a view cannot subscribe to resources (ext-apps #659). So when a call that may have
changed an app reaches it, whoever made the call, the host tells that app's open views: each
receives `centralu/notifications/changed`, which the host advertises under its `experimental`
capabilities.

- A call **may have changed** the app unless its tool is annotated `readOnlyHint: true`. A tool
  without annotations counts as possibly changing.
- A view is not told about a change its own instance caused (it already has that call's result);
  the app's other open views are. Notifications are coalesced per app.
- A view built from the template re-reads its state when told, by calling its read-only `show`. The
  template's rules require an annotation on every read tool for this reason.
- A view not built from the template ignores the notification and is not refreshed.

This is how a slider the person has open moves when an agent calls the tool behind it.

**When the app itself comes back on new code** (the builder's turn end, `check`, Restart after an
edit), a notification is not enough: the view's HTML is the old app's. The app list carries the
code the running process loaded (`codeStamp`, part of the folder fingerprint; unchanged by a
crash-and-restart of the same code, and by new code that failed to start). Each open view
remembers the stamp it opened on, and when the list says otherwise the UI reopens it: a pinned
view in place with a fresh `home` call, an inline view with its stored input and result (no tool
call again, even while its conversation is hidden). "Updated" stands in quiet text for a moment.
Only a new stamp reopens a view, never the notification above, which would let a reopened view's
first read cause the next reopen. A view reopens on its own at most 3 times a minute, because an
app that writes into its own folder would otherwise restart and reopen forever. After that it
shows "Changed · Reload" and waits for the person.

## How a view is hosted

A summary; the reasoning is in security-boundaries/app-views.md.

- The UI asks the host for a frame address (`apps.viewFrame`). The host serves a **sandbox proxy**
  page on its loopback port, behind a secret made at every launch. The proxy creates the inner frame
  with its `sandbox` set first, then gives it the app's HTML through `srcdoc`. Under the keeper the
  address names the front door's port and a secret derived from the keeper's token, and open
  instances are handed to the next host, so a view stays as it was across a build switch
  ([agent-host/lifecycle/front-door.md](../agent-host/lifecycle/front-door.md)). A linked machine's view is served the same way by the hub,
  from the machine's raw document and with the hub's own per-app origin ports, so storage stays
  apart per app and per machine in the one window that renders them all
  ([plans/remote-hub.md](../plans/remote-hub.md) §11).
- **Opaque origin** (default): the inner frame gets `allow-scripts allow-forms` only. No browser
  storage, so no two views share any. **Per-app origin** (`view.origin: "app"`): the inner frame is
  `allow-same-origin` on `http://127.0.0.1:<port>`, a port fixed for that (project, app) and never
  given to another app, because WebKit keeps storage per origin. It exists for apps that break
  without storage: 5 of 86 public apps in the spike's sample (S-8), including the ext-apps map
  example. The host listens on that port from the app's first view until the app is removed (its
  folder or its project) and its last view is closed; the port stays the app's, so an app put back
  gets the same origin (#392). A linked machine's app keeps its port open for the hub's life: the
  hub is not told when it is removed there.
- **CSP** comes from the resource's `_meta.ui.csp` (the standard's place) and is stricter than the
  standard's default: no network, no nested frames, no form submission, no `'self'` source, and
  this machine's addresses (loopback, unspecified and link-local, `isThisMachineHost`) dropped even when declared. `_meta.ui.permissions` passes only what is declared
  (camera, microphone, geolocation, clipboard-write). Both are read from the resource's **contents**
  entry, which the template runtime's `uiResource` leaves without `_meta`; the project-board app adds
  it there (`viewResource` in its server.mjs) to declare GitHub's image hosts as `resourceDomains`,
  so images in an issue it shows load and nothing else does.
- **Bridge**: the official ext-apps 2.x `AppBridge`, loaded the first time a view opens. The frame
  is recognised by `event.source`, and the app by the component that opened it. Tool calls go to
  `apps.invoke`; resource reads go to `apps.readResource`, for the frame's own app only; a link opens
  outside Centralu after the person confirms (http(s) and mailto only); log messages are accepted
  and dropped; size changes resize an inline view (24 to 2000 px), while a pinned view fills its
  area.
- **Host context**: the theme ([view-theme-layout-drag.md](view-theme-layout-drag.md#the-theme-in-a-view-312)), `displayMode: "inline"`, locale, time zone, and
  `centralu.fontScale` (reported only: the UI's own zoom already scales the frame).
