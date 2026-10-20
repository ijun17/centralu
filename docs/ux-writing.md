# UX writing: the words on screen

**Status: settled 2026-10-18, revised as the screen changes.** Section 1 holds the rules the app follows, each
with real strings from the code and the counterexamples found next to them; section 3 holds the choices the owner
made. Paths are relative to `packages/ui/src/features/`, except those that start with `app/`, `components/` or
`store/`, which are relative to `packages/ui/src/`. Strings that do not follow it yet are fixed in a copy pass.

How the screen looks is [design-system.md](design-system.md). This document is about what it says.

## 1. Rules the app already follows

### 1.1 Say only what the person can act on or would want to know

A state that needs nothing from the person is not announced. A line that stands on screen takes room and
attention from what does need them, and teaches the person to stop reading such lines (*owner,
2026-10-18*).

- Follows: a sleeping session used to show "Asleep — it wakes when you type to it" under the conversation,
  and " · asleep" in its mark's tooltip. Both are gone: sleep needs nothing, since typing to the session
  wakes it. What stays is what the person would want to know: "Waking session…" while it wakes, and, when it
  could not wake, the reason and Retry (`session/SessionNotes.tsx` `DormantNote`,
  `sidebar/marks/ToolMark.tsx`). The design system's states say the same (design-system.md §10).
- The same rule is why the top bar keeps its words in tooltips, and why a machine with no usable tool is left
  out of the usage capsules rather than drawn as "Offline" (design-system.md §6). Settings → Machines still
  lists every machine with its state, for the person who looks for it.

### 1.2 Sentence case

Labels, headings, menu items and tooltips capitalise the first word and proper names only.

- Follows: "New session" (`sidebar/menus/ProjectMenu.tsx`), "Load earlier messages"
  (`session/chat-stream/OlderSentinel.tsx`), "Restart to update" (`settings/UpdateLine.tsx`),
  "Add a machine" (`settings/MachinesSection.tsx`).
- Breaks it: "Open Runs" (`pinned-app/ErrorTail.tsx`), "Open Updates" (`settings/MachinesSection.tsx`),
  "Open Git" (`palette/CommandPalette.tsx`), where a panel's name is capitalised like a proper name. Also
  a heading in capitals, `GOAL` (`session/SessionHeader.tsx`).

### 1.3 A button says what it does, as a verb

The label is the action, in as few words as say it fully. It names the consequence when the consequence
is not the obvious one.

- Follows: "Move to trash" (`sidebar/dialogs/ConfirmDelete.tsx`), "Hand off"
  (`sidebar/dialogs/ConfirmHandoff.tsx`), "Allow once" / "Always for this session" / "Deny"
  (`approval/ApprovalCard.tsx`), "Continue in a fork" (`session/SessionNotes.tsx`), "Switch anyway"
  (`git/GitPanel.tsx`), "Not now" / "Trust" (`sidebar/project/TrustAsk.tsx`).
- An icon button's label is its tooltip and its accessible name (`components/IconButton.tsx`). The
  shortcut goes in parentheses, and so does a consequence that is not obvious:
  "Collapse panel (⌘B)" (`evidence/EvidencePanel.tsx`), "Remove from the grid (the session keeps
  running)" (`grid/GridView.tsx`), "Close terminal (the shell exits)" (`evidence/Terminal.tsx`).
- Breaks it: nouns as buttons, "Builder", "Runs", "Versions" (`pinned-app/PinnedApps.tsx`) and "Output"
  (`session/chat-rows/ChatRow.tsx`). These are toggles that open a panel, so they may be a case of their
  own (settled in section 3).

### 1.4 "…" when another step follows

A label ends in "…" (the single character, never "...") when pressing it opens a dialog or asks for
more before anything happens.

- Follows: "Customise…" and "Import…" (`settings/ThemeSection.tsx`), "New app…" and "Delete project…"
  (`sidebar/menus/ProjectMenu.tsx`), "Delete session…" and "Hand off to a fresh session…"
  (`sidebar/menus/SessionMenu.tsx`), "Other…" (`settings/OtherChoice.tsx`), "Delete for good…"
  (`settings/TrashSection.tsx`, then "Delete for good" on the confirmation itself).
- The same character means "in progress" on a label that changes while it works: "Restarting the agent…"
  (`session/SessionHeader.tsx`), "Deleting…" (`project/DeleteProjectDialog.tsx`), "Looking for Claude Code
  and Codex…" (`onboarding/Intro.tsx`), "Asking <machine> what is running…" (`settings/MachinesSection.tsx`).
- Breaks it: "Add a folder as a project" (`sidebar/Sidebar.tsx`) opens a folder picker
  without "…"; "running…" (`session/chat-rows/CentraluCall.tsx`) is the one progress word in lower case.

### 1.5 An error says what happened, why, and what to do

The common shape is "Could not <verb> <what>: <reason>", with a way to try again where there is one.

- Follows: "Could not read {what}: {error}" with Retry (`components/LoadFailed.tsx`, used for runs,
  the trash, grants), "Could not save the window layout; it is tried again on the next change or
  reconnect" (`store/connection.ts`), "<cannot>: <project> is not trusted. Trust the project to attach
  its apps." (`session/appReachNotice.ts`), "You did not allow <app> to <action>. This is your decision,
  not a bug in the app." (`pinned-app/ErrorTail.tsx`).
- A list that could not be read says so; it is never drawn as empty ("No changes" would be false), see
  `LoadFailed`.
- Breaks it: "Something went wrong" (the update capsule's tooltip with no error, `settings/UpdateLine.tsx`),
  "Commit failed" and "Push failed" with no reason (`evidence/GitChanges.tsx`), "Update failed: unknown
  reason" (`settings/apply-update.ts`), "Could not alert: …" (`store/events/notices.ts`, unclear what
  failed). Also "This session can't use <app>'s tools" (`session/appReachNotice.ts`), the one contraction
  among "Could not" and "cannot".
- How much of the reason to pass through: settled in section 3.

### 1.6 An empty state says there is nothing, and how to get something

- Follows: "No projects yet." then "Start with Add project below." (`sidebar/Sidebar.tsx`); "Nothing
  waiting" then "Finished agents collect here" (`inbox/Inbox.tsx`); "Drag sessions and apps here from the
  sidebar" then "They keep running — this is another way to look at them" (`grid/GridView.tsx`); "No
  versions yet. One is kept the first time the app starts." (`app-share/VersionsPanel.tsx`).
- Short where the next step is plain: "No commits yet", "No changes", "No results", "The trash is empty".
- Breaks it: "Empty" (`files/FileTree.tsx`) and "None." (`app-share/AppReviewDetails.tsx`) say less than
  their neighbours. Periods are mixed: "No projects yet." and "No runs yet." have one, most do not
  (settled in section 3).

### 1.7 Counts and times

- Digits, not words, and pluralised by the count: "3 background tasks running"
  (`session/BackgroundTasks.tsx`), "1 run" / "2 runs" (`pinned-app/RunsPanel.tsx`), "Attaching a file…" /
  "Attaching 3 files…" (`session/chat-rows/attachments.tsx`).
- More of the same is "· N more": "api finished · 2 more" (`inbox/InboxPill.tsx`). Parts of one line are
  joined by " · ": "4 sessions · 630 MB" (`settings/TrashSection.tsx`).
- Formats live in `app/format.ts`, all in English whatever the system's language: sizes "812 B", "1.5 KB"
  (a space); durations "1.5s", "3m 20s", "2h 5m"; token counts "1.5k", "10k+"; the time under a bubble
  "3:42 PM"; a day divider "Saturday, October 18, 2026"; ages "just now", "5m ago", "3d ago"
  (`app/labelClock.ts`).
- Breaks it: "2 error", "3 limit reached" (`sidebar/marks/FoldSummary.tsx`, the state label lower-cased
  and not pluralised); "Reconnecting for 5+ min" (`components/primitives.tsx`), the one "min" among "m".

### 1.8 Tool, machine and product names

- Tools are named as their makers name them, from the adapter's label: "Claude Code", "Codex"
  ("Install or sign in to Claude Code or Codex", `usage/UsageDonuts.tsx`). Never "Claude" alone for the
  tool.
- A linked machine is named by the name the person gave it: "Runs on <name>" (`machines/MachineTag.tsx`).
- The product is "Centralu", used where the person needs to know who did something: "Stopped: Centralu
  quit or restarted" (`components/primitives.tsx`), "Keep agents running after Centralu quits"
  (`settings/Settings.tsx`).
- Breaks it: this computer is "This computer" (`sidebar/menus/AddProjectMachines.tsx`)
  and "this machine" ("Usage on this machine", `usage/UsageDonuts.tsx`;
  `settings/TrashSection.tsx`; `project/NewAppDialog.tsx`) (settled in section 3).

### 1.9 No internal words on screen unless the person needs them

Words for how Centralu is built (host, keeper, swap, sidecar, RPC, adapter, manifest, bridge) stay off the
screen unless the person can act on them. "swap", "sidecar", "RPC", "adapter" and "PID" are not on screen.
These are:

- "agent host": "Connecting to the agent host…", "Not connected to the agent host — nothing can start
  until it is back." (`orchestrator/OrchestratorView.tsx`), "…they run in the agent host, not in this
  window. Reloading rebuilds the screen from the host." (`app/ErrorBoundary.tsx`), "The host kept
  disconnecting while opening this screen" (`store/viewReconnect.ts`), "Not connected to the host"
  (`store/apps.ts`), "The agent host switches to it from the bar above." (`settings/apply-update.ts`).
- "keeper": "…a desktop app whose agent host is not held by the background keeper" (`settings/apply-offer.ts`).
- "manifest", "bridge": "the app's manifest is not valid", "the app's bridge did not start in this session"
  (`session/appReachNotice.ts`). "MCP": "Dismissed MCP proposal: <name>" (`store/orchestrator.ts`). A tool
  name, "(update_centralu with action install)" (`settings/apply-offer.ts`).
- "<session id>" in a hint (`project/NewSessionDialog.tsx`). "host" also means an ssh host
  (`settings/AddMachineForm.tsx`), which is the person's own word there.

Where one of these stays, it should be because the next step needs it (settled in section 3).

### 1.10 Tooltips are short

A phrase, often with no period. It names what a control does, or adds the one thing the label could not
hold.

- Follows: "Switch branch" (`evidence/EvidencePanel.tsx`), "Add an existing folder as a project"
  (`sidebar/Sidebar.tsx`), "Folder access permission required" (`sidebar/marks/ProjectMarks.tsx`),
  "Moves it to the Trash — you can put it back from there" (`files/FileTree.tsx`). The top bar's capsules
  keep their words in the tooltip, not on the bar (design-system.md §6): "3 background tasks running",
  then "Open the list to follow or stop them" (`session/BackgroundTasks.tsx`).
- Breaks it: whole sentences with periods, "Restart every idle session on the installed version. Busy
  sessions keep running." (`session/AgentVersionNotice.tsx`), "Unlink it: its sessions and projects leave
  this computer's lists. Nothing on the machine changes." (`settings/MachinesSection.tsx`); a fragment with
  a period, "See sessions and apps side by side." (`sidebar/GridButton.tsx`); a 19-word tooltip, "Create a
  new, empty folder as a project, in the Centralu folder of your home unless you choose another"
  (`sidebar/Sidebar.tsx`).

### 1.11 A confirmation asks, says what follows, and repeats the verb

- Follows: "Move this session to the trash?" then "Move to trash" (`sidebar/dialogs/ConfirmDelete.tsx`);
  "Delete “<name>” for good? Its conversation, attachments and handoff note leave this machine… This cannot
  be undone." then "Delete for good" (`settings/TrashSection.tsx`); "Remove <app>? Its folder moves to the
  app trash and agents lose its tools. Its run records stay." (`settings/Settings.tsx`). In place, Cancel
  comes first, then the action (`components/InlineConfirm.tsx`).
- What is lost is said in the danger ink: "Uncommitted work in it would be lost once it is deleted."
  (`sidebar/dialogs/ConfirmDelete.tsx`).
- Breaks it: "Remove?" with "Keep" (`settings/MachinesSection.tsx`) where every other one says "Cancel";
  "the Trash" (the OS's) and "trash" (Centralu's) are both written for different things, and not always
  the right one (settled in section 3).

### 1.12 One state, one wording

A state the person has to recognise should read the same everywhere. Today: "Awaiting approval"
(`components/primitives.tsx`, `approval/ApprovalCard.tsx`), "Needs approval" (`inbox/Inbox.tsx`) and
"<name> asks for approval" (`inbox/InboxPill.tsx`) are the same state. The inbox is "Waiting"
(`inbox/Inbox.tsx`) and "Waiting list" (`palette/CommandPalette.tsx`). A stop is "Stopped: network"
(`components/primitives.tsx`) beside "A network error ended the last turn before it finished."
(`session/SessionNotes.tsx`).

### 1.13 Voice, as it is

- "you" and "your" are used directly where the person is the subject: "Needs your answer"
  (`inbox/Inbox.tsx`), "Nothing restarts until you apply it." (`settings/UpdateLine.tsx`), "Faster
  answers spend more of your usage." (`session/SessionSettings.tsx`).
- No "please", no exclamation marks, no "we".
- Spelling is British ("Customise…", "Accent colour", `settings/ThemeSection.tsx`), while dates and times
  are American ("3:42 PM", "October 18") (settled in section 3).

## 2. When a string is added

A new string follows sections 1 and 3, and copies the nearest existing string that does.

## 3. Decided (owner, 2026-10-18)

These settle the choices the draft asked about. Strings that do not follow them yet are fixed in a copy pass.

| Question | Decision | Example |
|---|---|---|
| Tone | Plain and brief: say what is and what to do, no warmth, no jokes | "Nothing waiting" |
| Addressing the person | "you" where the person is the subject, impersonal elsewhere | "Needs your answer"; "Nothing restarts until you apply it." |
| How much an error explains | What failed, a plain reason and the next step; the raw reason behind "Details". "Something went wrong" goes | "Could not read this app's runs: its record file is missing. Runs start being recorded on the next call. Details" |
| Periods | None on a label, a tooltip or a single-line hint; one when there are two sentences or more | "Switch branch"; "Restart every idle session on the installed version. Busy sessions keep running." |
| Spelling and formats | American throughout | "Customize…", "Accent color", "3:42 PM" |
| This computer | "This computer" everywhere | "Usage on this computer" |
| Trash | "the Trash" for the OS's, "Centralu's trash" for Centralu's | "Move the folder to the Trash too"; "Chat history stays in Centralu's trash" |
| Labels that open a place | A toggle that opens a panel may be its noun; an action is a verb | "Runs" (toggle); "Open in VS Code" (action) |
| One word per state | The state label on marks and cards; a sentence with the session's name in the capsule's peek | "Awaiting approval"; "api asks for approval" |
| Korean | English only for now; Korean appears only in what the person and the agents write | |
| Internal words | Never on screen; say what the person sees. Covers "agent host", "keeper", "manifest", "bridge", "MCP" and tool names such as `update_centralu` | "Not connected to the agent host" → "Centralu is reconnecting — nothing can start until it is back" |
