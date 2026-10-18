# UX writing: the words on screen

**Status: draft, to be settled with the owner.** The rules below are the ones the app already follows
most of the time. They are written down here so they can be argued about. Each one has real strings from
the code and the counterexamples found next to them. Paths are relative to `packages/ui/src/features/`,
except those that start with `app/`, `components/` or `store/`, which are relative to `packages/ui/src/`. The last
section lists the choices only the owner can make. Until those are settled, no string changes because of
this document, and it stays in English only.

How the screen looks is [design-system.md](design-system.md). This document is about what it says.

## 1. Rules the app already follows

### 1.1 Sentence case

Labels, headings, menu items and tooltips capitalise the first word and proper names only.

- Follows: "New session" (`sidebar/menus/ProjectMenu.tsx`), "Load earlier messages"
  (`session/chat-stream/OlderSentinel.tsx`), "Restart to update" (`settings/UpdateLine.tsx`),
  "Add a machine" (`settings/MachinesSection.tsx`).
- Breaks it: "Open Runs" (`pinned-app/ErrorTail.tsx`), "Open Updates" (`settings/MachinesSection.tsx`),
  "Open Git" (`palette/CommandPalette.tsx`), where a panel's name is capitalised like a proper name. Also
  a heading in capitals, `GOAL` (`session/SessionHeader.tsx`).

### 1.2 A button says what it does, as a verb

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
  own (open question 3.9).

### 1.3 "…" when another step follows

A label ends in "…" (the single character, never "...") when pressing it opens a dialog or asks for
more before anything happens.

- Follows: "Customise…" and "Import…" (`settings/ThemeSection.tsx`), "New app…" and "Delete project…"
  (`sidebar/menus/ProjectMenu.tsx`), "Delete session…" and "Hand off to a fresh session…"
  (`sidebar/menus/SessionMenu.tsx`), "Other…" (`settings/OtherChoice.tsx`), "Delete for good…"
  (`settings/TrashSection.tsx`, then "Delete for good" on the confirmation itself).
- The same character means "in progress" on a label that changes while it works: "Restarting the agent…"
  (`session/SessionHeader.tsx`), "Deleting…" (`project/DeleteProjectDialog.tsx`), "Looking for Claude Code
  and Codex…" (`onboarding/Intro.tsx`), "Asking <machine> what is running…" (`settings/MachinesSection.tsx`).
- Breaks it: "New folder" and "Add project" (`sidebar/Sidebar.tsx`) open a dialog or a folder picker
  without "…"; "running…" (`session/chat-rows/CentraluCall.tsx`) is the one progress word in lower case.

### 1.4 An error says what happened, why, and what to do

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
- Open: how much of the reason to pass through as the system wrote it (open question 3.3).

### 1.5 An empty state says there is nothing, and how to get something

- Follows: "No projects yet." then "Start with Add project below." (`sidebar/Sidebar.tsx`); "Nothing
  waiting" then "Finished agents collect here" (`inbox/Inbox.tsx`); "Drag sessions and apps here from the
  sidebar" then "They keep running — this is another way to look at them" (`grid/GridView.tsx`); "No
  versions yet. One is kept the first time the app starts." (`app-share/VersionsPanel.tsx`).
- Short where the next step is plain: "No commits yet", "No changes", "No results", "The trash is empty".
- Breaks it: "Empty" (`files/FileTree.tsx`) and "None." (`app-share/AppReviewDetails.tsx`) say less than
  their neighbours. Periods are mixed: "No projects yet." and "No runs yet." have one, most do not
  (open question 3.4).

### 1.6 Counts and times

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

### 1.7 Tool, machine and product names

- Tools are named as their makers name them, from the adapter's label: "Claude Code", "Codex"
  ("Install or sign in to Claude Code or Codex", `usage/UsageDonuts.tsx`). Never "Claude" alone for the
  tool.
- A linked machine is named by the name the person gave it: "Runs on <name>" (`machines/MachineTag.tsx`).
- The product is "Centralu", used where the person needs to know who did something: "Stopped: Centralu
  quit or restarted" (`components/primitives.tsx`), "Keep agents running after Centralu quits"
  (`settings/Settings.tsx`).
- Breaks it: this computer is "This computer" (`sidebar/menus/AddProjectMachines.tsx`,
  `project/CreateProjectDialog.tsx`) and "this machine" ("Usage on this machine", `usage/UsageDonuts.tsx`;
  `settings/TrashSection.tsx`; `project/NewAppDialog.tsx`) (open question 3.7).

### 1.8 No internal words on screen unless the person needs them

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

Where one of these stays, it should be because the next step needs it (open question 3.6).

### 1.9 Tooltips are short

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

### 1.10 A confirmation asks, says what follows, and repeats the verb

- Follows: "Move this session to the trash?" then "Move to trash" (`sidebar/dialogs/ConfirmDelete.tsx`);
  "Delete “<name>” for good? Its conversation, attachments and handoff note leave this machine… This cannot
  be undone." then "Delete for good" (`settings/TrashSection.tsx`); "Remove <app>? Its folder moves to the
  app trash and agents lose its tools. Its run records stay." (`settings/Settings.tsx`). In place, Cancel
  comes first, then the action (`components/InlineConfirm.tsx`).
- What is lost is said in the danger ink: "Uncommitted work in it would be lost once it is deleted."
  (`sidebar/dialogs/ConfirmDelete.tsx`).
- Breaks it: "Remove?" with "Keep" (`settings/MachinesSection.tsx`) where every other one says "Cancel";
  "the Trash" (the OS's) and "trash" (Centralu's) are both written for different things, and not always
  the right one (open question 3.8).

### 1.11 One state, one wording

A state the person has to recognise should read the same everywhere. Today: "Awaiting approval"
(`components/primitives.tsx`, `approval/ApprovalCard.tsx`), "Needs approval" (`inbox/Inbox.tsx`) and
"<name> asks for approval" (`inbox/InboxPill.tsx`) are the same state. The inbox is "Waiting"
(`inbox/Inbox.tsx`) and "Waiting list" (`palette/CommandPalette.tsx`). A stop is "Stopped: network"
(`components/primitives.tsx`) beside "A network error ended the last turn before it finished."
(`session/SessionNotes.tsx`).

### 1.12 Voice, as it is

- "you" and "your" are used directly where the person is the subject: "Needs your answer"
  (`inbox/Inbox.tsx`), "Asleep — it wakes when you type to it" (`session/SessionNotes.tsx`), "Faster
  answers spend more of your usage." (`session/SessionSettings.tsx`).
- No "please", no exclamation marks, no "we".
- Spelling is British ("Customise…", "Accent colour", `settings/ThemeSection.tsx`), while dates and times
  are American ("3:42 PM", "October 18") (open question 3.5).

## 2. When a string is added

Until the open questions are settled, a new string follows section 1 and copies the nearest existing
string for the same thing, so it stays consistent. It does not start a new wording.

## 3. Open questions

Each one needs the owner's choice. An option marked "(today)" is what the app mostly does now; that is not a
recommendation. Where nothing is marked, the app does not settle on one yet.

### 3.1 Tone

| Option | Example |
|---|---|
| A. Plain and neutral: say what is, no warmth, no jokes (today) | "Nothing waiting" |
| B. Plain, with a little warmth where nothing is wrong | "Nothing waiting. Finished agents will show up here" |
| C. Terse, closer to a terminal | "0 waiting" |

### 3.2 Addressing the person

| Option | Example |
|---|---|
| A. "you" where the person is the subject, impersonal elsewhere (today) | "Needs your answer"; "Nothing restarts until you apply it." |
| B. Always impersonal | "Answer needed"; "Nothing restarts until the update is applied." |
| C. Always "you", and the app speaks as "Centralu" | "Centralu needs your answer" |

### 3.3 How much an error explains

| Option | Example |
|---|---|
| A. What failed, then the system's reason as written (today) | "Could not read runs: ENOENT: no such file or directory, open '…/runs.jsonl'" |
| B. What failed, a plain reason, and the next step; the raw reason behind "Details" | "Could not read this app's runs: its record file is missing. Runs start being recorded on the next call. Details" |
| C. A short line, and the full reason only in a tooltip or a log | "Could not read runs" (tooltip: the raw error) |

Whichever is picked: is a bare "Commit failed" ever enough, and should "Something went wrong" be removed?

### 3.4 Periods

| Option | Example |
|---|---|
| A. No period on a label, a tooltip or a single-line hint; a period when there are two sentences or more | "Switch branch"; "Restart every idle session on the installed version. Busy sessions keep running." |
| B. Never a period on screen except in a dialog's body text | "No projects yet" |
| C. A period on every full sentence, whatever its length | "See sessions and apps side by side." |

### 3.5 Spelling and formats

| Option | Example |
|---|---|
| A. British spelling, American dates and times (today) | "Customise…", "3:42 PM" |
| B. American throughout | "Customize…", "Accent color", "3:42 PM" |
| C. British throughout | "Customise…", "15:42", "18 October 2026" |

### 3.6 Internal words

| Option | Example |
|---|---|
| A. Never on screen; say what the person sees | "Not connected to the agent host" → "Centralu is reconnecting — nothing can start until it is back" |
| B. Allowed in Settings and in errors where the next step needs them, defined once in Settings | "The agent host restarted (Settings → About explains what it is)" |
| C. Allowed wherever they are accurate (today, mostly) | "…a desktop app whose agent host is not held by the background keeper" |

The same choice covers "manifest", "bridge", "MCP" and tool names such as `update_centralu`.

### 3.7 This computer

| Option | Example |
|---|---|
| A. "This computer" everywhere | "Usage on this computer" |
| B. "This machine" everywhere, the word used for linked machines | "This machine", "Add a machine" |
| C. The computer's own name, with "this computer" only where there is no name | "Usage on Jun's MacBook" |

### 3.8 Trash

| Option | Example |
|---|---|
| A. "the Trash" for the OS's, "Centralu's trash" for Centralu's, written out each time | "Move the folder to the Trash too"; "Chat history stays in Centralu's trash" |
| B. Centralu's trash gets its own name | "Move to Recently deleted" |
| C. One lower-case "trash" for both, the place named only where it matters | "Moves it to the trash (Finder)" |

### 3.9 Labels that open a place

| Option | Example |
|---|---|
| A. A toggle that opens a panel may be its noun; an action is a verb (today) | "Runs", "Versions" (toggles); "Open in VS Code" (action) |
| B. Always a verb | "Show runs", "Show versions" |
| C. A noun with the place capitalised as a name | "Open Runs", "Open Git" |

### 3.10 One word per state

| Option | Example |
|---|---|
| A. The state label everywhere (`stateLabel`) | "Awaiting approval" in the inbox, the mark's tooltip and the card |
| B. The state label on marks and cards, a sentence with the session's name in the capsule's peek | "Awaiting approval"; "api asks for approval" (today, partly) |
| C. A shorter word everywhere | "Approval" / "Question" / "Error" |

### 3.11 Korean, later

| Option | Example |
|---|---|
| A. English only; Korean appears only in what the person and the agents write | (today) |
| B. A Korean translation behind a setting; every string gets a key; English stays the source | "New session" / "새 세션"; "3:42 PM" / "오후 3:42" |
| C. The system's language, Korean included, with dates and times in that language too | "토요일, 2026년 10월 18일" in the day divider |

If B or C: are product words (session, approval, project, app) translated or kept in English, and do
times follow the language or stay English as `formatSaidAt` decides today?
