# Centralu Product Spec

> A lightweight desktop app that runs, watches and controls several agentic coding tools (Claude Code, Codex CLI) from a single window

- Version: v0.5 (**synced to the implementation, 2026-08-26** — M2 is done and the app is in dogfooding, so this document now describes what exists, not what is planned)
- Written: 2026-08-15 (v0.4), realigned 2026-08-26 (v0.5)
- Status: shipped through M2; M2.5 (dogfooding) in progress
- Main changes v0.4 → v0.5: §2's M0 preconditions recorded as verified; FR-4 updated to the evidence-panel tab layout (History split out of the git panel); FR-9 rewritten to what shipped (limit windows, not a cost dashboard); FR-11 rewritten to the implemented orchestrator design (kind marker, central/per-project hierarchy, curated tools, crown mark); the terminal non-goal withdrawn (§1.5); grid still experimental with its two live objections (§5.4); architecture (§6) corrected to the Node-host reality; measured numbers added to §7.1; roadmap (§8) marked up to date
- Main changes v0.3 → v0.4: product philosophy written down (§1.2), approval allowed in place from the banner (jump only when context is needed), the concurrent-session warning softened to inline plus a recovery path, session archive (FR-20)·conversation search (FR-21)·card collapse policy added, inbox promoted to M1, React settled as the front end, 4 open questions closed

---

## 1. Overview

### 1.1 The problem

Use agentic coding tools for real work and you end up running **several projects × several sessions** at once. What hurts about the current workflow:

- Terminal tabs multiply into the dozens, and there is no way to tell **which session is waiting on my input**.
- To see what files an agent changed you have to open an IDE or run `git status` separately, per project.
- Usage and context state per tool (Claude Code / Codex) is scattered, so you never have a picture of it.
- Running several IDEs for this eats more RAM and battery than a machine can take.

The core of it is **that the terminal tabs are scattered**, not that you cannot see several sessions at once. That distinction is where the screen design (§5) starts.

### 1.2 What the product is

**Centralu** is an "agent control tower". Not a tool that *writes* code — a tool for **watching, intervening in and managing** agents writing code, from one screen.

The essence of a control tower is **not showing everything, but picking out the thing you need to look at right now**.

**Product philosophy — the test every feature decision is put to:**

> **Centralu does not control. It makes control possible.** It does not restrict the agent's autonomy or the user's workflow; it shows precisely what is happening right now and what is waiting on my judgement. **Do not block, make visible.** And the most expensive resource in this system is not tokens, it is **human attention**.

Every time a feature is added or changed, ask against this standard: is this coercion or visibility, does it conserve human attention or waste it?

3 core values:

1. **Miss nothing** — know instantly which session is waiting for my response, and how urgent it is
2. **Intervene immediately** — handle approvals and responses quickly from the keyboard and move on to the next waiting item
3. **Stay light** — one app that consumes almost nothing while idle, instead of several IDEs

### 1.3 The core usage loop (the real behaviour this product has to support)

```
come back to the desk
  → check the inbox: "2 waiting for approval · 3 waiting for a response"
  → handle the urgent ones (approvals) first, in sequence, from the keyboard
  → for the ones waiting on a response, read the result (mark read) then give the next instruction or end it
  → when it is all empty, leave the desk (the agents keep working)
```

Every screen, shortcut and notification design is judged by how fast this loop turns. The metric is not "how much does it show" but **"how fast is one turn of the loop"**.

### 1.4 Design principles

1. **Separate observation from operation** — observation (grasping state) needs almost no space (status dots, badges, counters). Operation (reading a conversation, approving, instructing) needs a lot of space. So observation goes in a dense sidebar and inbox, operation in a full-width focus view.
2. **Distinguish urgency** — "the agent is blocked (waiting for approval)" and "the turn is over" are different pieces of information. Never merge them into the same badge.
3. **Keyboard first** — every action in the control loop (moving between sessions, approving, cycling the inbox) must be possible without a mouse. A GUI slower than a mouse is worse than a terminal.
4. **State and read-status are separate** — "is this session waiting" and "have I seen the result" are independent axes.

### 1.5 Non-goals

To stop the scope leaking, what v1 explicitly **does not do**:

- Code **editing** (viewer only; editing is the IDE's job)
- ~~A terminal emulator (agent conversation is a structured GUI, not a raw terminal)~~ — **withdrawn 2026-08-26.**
  The evidence panel has a Terminal tab. What the line was protecting still stands — the **agent conversation**
  is a structured GUI, not a PTY wrap — but a project terminal beside it turned out to be part of watching a
  project, not a replacement for the conversation. Recorded rather than deleted, same reasoning as the grid line below.
- Advanced git operations (rebase, cherry-pick etc. — read-oriented; commit/staging come later)
- Remote/cloud execution (local projects on the local machine only)
- Tools other than Claude Code and Codex (only the adapter structure is designed to extend)
- ~~**Concurrent split grid view**~~ — **withdrawn 2026-08-20.** It was built, and it ships marked **experimental** (§5.4).
  The line is kept rather than deleted: there was a period where this document said "we do not build this"
  while the grid was on screen (issue #25), and where that mismatch came from must not vanish from the list.

---

## 2. Settled technical direction

| Item | Decision | Reasoning |
|---|---|---|
| App shell | **Tauri 2.x** (Rust core + native webview) | The "lightweight" requirement. Drastically lower memory and energy use than Electron |
| Supported agents (v1) | **Claude Code, Codex CLI** | User's decision. Extensible later through the adapter interface |
| Integration | **SDK/protocol based** (not PTY wrapping) | Receive state detection (is it waiting), context usage and approval requests precisely, as structured events |
| Agent adapter execution | Node.js sidecar process | Run the Claude Agent SDK (TypeScript) and the Codex protocol client in Node, supervised by Tauri |
| Front end | **React** (settled) | Idle energy is decided by the render policy (§7.1), not the framework. The ecosystem and agent-driven-development friendliness are a clear advantage |
| Local storage | SQLite (app data directory) | Persist workspace/session/usage cache, restore on restart |

**Integration detail:**

- **Claude Code** → Claude Agent SDK (TypeScript). Provides streaming messages, session resume, tool call events, the permission request callback (`canUseTool`) and token/context information in structured form.
- **Codex CLI** → the `codex app-server` JSON-RPC (stdio) protocol. Handles conversation stream, approval requests and session management programmatically. (Protocol differences between versions are absorbed inside the adapter.)
- Both tools are hidden behind a **common adapter interface**. → §6.2

**⚠ Precondition for approval events — verified in M0, the approval UI stands:**
If the user has set the CLI to global bypass (auto-approve), approval request events **do not fire at all**. For Centralu's approval UI to mean anything, the permission preset at session creation (FR-7) had to be able to override the global setting per session. **M0 confirmed it can** — the Claude Agent SDK takes `permissionMode`/`canUseTool` per session, and Codex accepts per-thread approval policy — so sessions created in Centralu behave according to their chosen preset regardless of the global setting.

---

## 3. Terminology

| Term | Definition |
|---|---|
| Project | One registered local directory. It may or may not be a git repository |
| Session | One agent conversation instance. Belongs to a project and has a tool (Claude Code/Codex), model and permission setting |
| Adapter | A module wrapping a specific agent tool in the common interface |
| Orchestrator session | A session with `kind: 'orchestrator'` — able to inspect and instruct sessions within its scope. One central orchestrator (no project) plus at most one per project; scope follows 중앙 > 프로젝트 > 세션 (FR-11) |
| Workspace | The registered project list + layout + the full state of open sessions (the unit of restore) |
| Inbox | A triage view that ignores project structure and shows only "items waiting on my intervention right now" |
| Read/unread | Independent of session state: whether there is new content since I last looked |
| Archive | The state where the session process is terminated and it is cleared from the list, but the conversation record is kept |

---

## 4. Functional requirements in detail

### 4.1 The original 14 requirements, worked out (FR-1 ~ FR-14)

`FR-n` corresponds to the original requirement number.

#### FR-1. Multi-project management (sidebar + focus view)

- "4+ projects in one window" is satisfied by **being able to register 4+ in one window and move between them quickly**. Concurrent split display (the grid) also exists but is an **experimental feature**; what satisfies this requirement is the sidebar, not the grid (§5.4).
- Left sidebar: the full project/session tree, densely displayed at all times — project name, branch, changed file count, per-session status dot and unread mark. **This is enough for observation.**
- Right focus view: one selected session takes the full width — conversation, files, git and viewer tabs at a size where they can actually be seen.
- Project registration: pick a directory or drag and drop. Keeps a recent projects list.
- Switching is by keyboard: ⌘1~9 to jump projects, j/k to move between sessions (→ FR-17).

#### FR-2. Worktrees not forced + concurrent session safeguards

- **Working directly in the original directory is the default.** Git worktrees are neither created nor required.
- Directories that are not git repositories can be registered as projects too (only the git panel is disabled).
- **Concurrent sessions are a data loss risk** (one agent overwrites another's changes). The handling — not blocking, but **visibility + recovery**:
  - An **inline warning inside** the session creation dialog (no modal, no extra click): "N sessions running in this directory — if they modify the same file, changes may be lost". Read it and carry on. (Breaking the flow with a modal violates "do not block, make visible")
  - While running, show "N concurrent sessions" permanently in the project header.
  - When two sessions are detected to have **actually modified the same file** (based on tool call events), a warning badge + a **recovery path**: offer "view this file's previous state" from the pre-change content left in the tool call event. Whether Claude Code's file checkpoints can be used for recovery is checked in M0. By the time it is detected it is already too late, so recovery helps more than a warning does.
- (Lower-priority option) a "run in a worktree" checkbox at session creation — isolation for whoever wants it. **Implemented 2026-08-19.**
  - The location is **outside the repository** (`<data folder>/worktrees/<project>/<session>`). Inside the repository you would have to
    add a line to `.gitignore` (us editing the user's file) and without it `git status` gets messy.
  - The branch is `centralu/<first 8 chars of session id>`. A session name either does not exist at creation time (auto names arrive later)
    or has spaces and Unicode mixed in and cannot be used as a branch name.
  - **If it is not a git repository, do not create one and say why.** Silently falling back to the original directory means
    the user thinks they are isolated and points two sessions at the same file — which is exactly why they turned this on.
  - **Resume and app restart return to the same worktree** (the path is kept in the DB).
  - When deleting, **ask**: show the number of uncommitted changes and the path, and require a checkbox to delete.
    Hours of an agent's work may be sitting there.

#### FR-3. GUI agent conversation

- Chat-style UI: user message / agent response (streaming markdown) / tool call card (collapsed by default, expand for detail).
- Tool call card: shows the command, file path and diff summary in structured form. Raw output only on expand. **The collapse default differs by tool kind**: read-oriented ones (Read/Grep/read-oriented Bash) are collapsed — 20 in a row still does not bury the conversation. File changes (Edit/Write) default to an expanded diff summary. Adjustable per tool in settings. (Half of the conversation view's readability is this policy)
- Session control: interrupt, retry, new session, rename session (auto naming is FR-18).
- Message input: multiline, attachments (FR-13), slash command passthrough (where the tool supports it).

**Approval interaction in detail (the most frequently used interaction — usability is decided here):**

- **Keyboard first**: with an approval request focused, `y` allow / `n` deny / `a` always allow. No mouse needed. Buttons shown alongside.
- **The scope and expressiveness of "always allow"**: show the scope as you press — the default is **session scope**, with a modifier (⌥a) for project scope. Record which scope it was saved at on the approval card. Allow pattern rules (e.g. `npm test*`), but when registering one, **preview the list of commands in the current session's history that match that pattern**. Full rules can be inspected and deleted in settings. Rather than limiting expressiveness, make the consequences visible.
- **Approval requests from unfocused sessions**: show the request in a global notification banner (top of the window), and **allow y/n approval straight from the banner**. But requests where the banner's information is not enough to judge — file edits (you have to see the diff), multi-file operations, long commands that get truncated — show **"needs review"** instead of an approve button, and Enter jumps to the session to approve there. The criterion is a per-tool-kind default (Bash: approvable in place if the full command is visible / Edit·Write: diff must be checked → jump), adjustable in settings. This is not coercion, it is **telling you the information is insufficient**.
- **Approval queue**: when several approvals pile up, handle them in sequence from the inbox (FR-15) — handling one automatically moves to the next approval.
- The approval request card summarises what is needed to judge: the full command, or the file path + a diff preview.

#### FR-4. Git status GUI

Lives in the right-hand **evidence panel**, whose tabs are **Git / History / Files / Terminal** (as built — the original "3-tab git panel" reshaped in use):

- **Git (changes)**: staged/unstaged/untracked file list; clicking a file shows a diff view. Updates live when an agent changes a file.
- **History**: a separate tab, not a strip inside the git panel — the embedded strip caused overlap when panels were split and could not spare the height for a real graph (dogfooding, 2026-08-26). Commit log with branch lanes; clicking a commit shows its changed files and diff.
- **Branches**: opened from the panel header — local branch list, current branch shown, checkout not blocked even when dirty; **show the files that would be affected first, then ask whether to proceed** (M2 decision: 'do not block, make visible').
- **Jump to the IDE**: on a diff or file list, open that file at that line in the default editor. The key detail for cutting the round-trip cost.
- Implementation: a `git` CLI wrapper in agent-host (settled in M2 — moving to Rust git2 is deferred until measurement confirms a bottleneck).
- v1 is **read-oriented**. Commit/staging/push is **settled for v1.5** — added to the same panel right after the read panel (M2) is finished. Advanced operations such as rebase and cherry-pick remain non-goals.

#### FR-5. Project file tree

- Explorer-style tree. **lazy-load** (only directories you open are read — stays light even in a large repo).
- A `.gitignore`-based filter toggle (default: ignored hidden).
- Git status overlay (M/A/U shown as **glyphs** — following the achromatic palette decision, no colour is used).
- Highlight files an agent recently modified (tracking "files the agent just touched").
- **Notices external changes** (issue #34, shipped 2026-08-25): non-recursive watches on the expanded directories only,
  flushed on a 300ms interval — the tree follows what agents and editors do to the disk without polling the whole repo.

#### FR-6. Code viewer (read-only)

- Click a file → syntax-highlighted read-only view. Search (within the file), line numbers, copy line link.
- Toggle between diff mode and normal mode.
- Large files use virtual scrolling; binaries/images get a preview or a notice.
- No editing (non-goal). An "open in IDE" button (the same mechanism as FR-4's line-level jump).

#### FR-7. Per-project and per-session tool selection

- Chosen in the session creation dialog: **tool** (Claude Code / Codex) → **model** → **permission preset** (safe/normal/auto-approve) → starting prompt.
- **The permission preset overrides the CLI's global setting per session** (verified in M0 — see §2). Regardless of the user's global bypass setting, a session created in Centralu behaves according to the chosen preset.
- The model & effort menu also carries per-tool knobs the tools expose: Claude effort levels, **Codex `model_verbosity`** (issue #54, shipped 2026-08-25 — measured on real runs to change output length before being surfaced).
- Per-project defaults saved ("this project defaults to Codex + gpt-5.x").
- Sessions of different tools can run simultaneously within one project (e.g. implement with Claude Code + review with Codex).

#### FR-8. Lightness (the key non-functional requirement → numeric targets in §7)

- The structure is Tauri + a light front end + 1 Node sidecar. Agent CLI processes exist only while there is a session.
- The focus view structure also helps performance: only one session has to be rendered on screen, so the standing render load is lower than a grid's. Unfocused sessions only receive events to update status and unread state.
- File watcher debounce, event-driven instead of polling.
- Target summary: CPU ~0% while idle, app's own memory under a few hundred MB. See §7.1.

#### FR-9. Agent usage + limit status

**What shipped is the limit-window view, not a cost dashboard.** The usage panel shows **subscription limit windows** per tool — Claude's 5-hour + weekly windows, Codex's weekly window — rendered as an array so a tool growing a new window does not require a UI change. Extra-payment credits are out of scope.

- **Hitting the limit is a first-class state** (you meet it often in real use): when a session hits a rate limit, show the session state as `limited` and, as far as the tool provides it, the **expected reset time** in the session header and the inbox.
- The original weekly **cost** dashboard (daily bars, per-project/model breakdown, estimated cost) remains open. The research still holds if it is built: weekly aggregation is impossible through the SDK (per-turn usage only, no plan-limit API for subscription accounts), so **log parsing is the only path** — `~/.claude/projects/**` JSONL and `~/.codex/sessions/**` token_count events, cached in SQLite with incremental parsing. Whether the hour it costs is worth it is a dogfooding-era judgement call, not a settled commitment.

#### FR-10. Restore on restart

- Save a workspace snapshot on exit: project list, layout, and per project the open session IDs, tools, names and read positions.
- On restart:
  - UI and layout restored immediately
  - Conversation record loaded immediately from local logs/SQLite (shown read-only first)
  - Session processes are **resumed where resume is possible** (Claude Agent SDK resume, `codex resume`); where not, offer "view the record only + start a new session"
- Make explicit that an agent turn that was in flight is interrupted when the process dies (restore is "continue the conversation", not "continue the turn").
- Crash safety: the snapshot is saved on every state change, not at exit.

#### FR-11. Orchestrator sessions (implemented 2026-08-25, issues #13 · #30 — this section describes what was built)

The single-workspace-crown design gave way to a **hierarchy** once real use showed one conversation cannot hold every project's context:

- **Kind is an explicit marker**, not a null check: a session is `kind: 'orchestrator'` or a normal session. There is one
  **central orchestrator** (belongs to no project) and optionally **one orchestrator per project**. Scope follows the
  hierarchy 중앙 > 프로젝트 > 세션: the central orchestrator reaches everything, a project orchestrator only its own
  project's sessions (an `inScope` predicate guards every tool call).
- Any session can be **promoted** to its project's orchestrator (and demoted back). Promotion takes effect on the session's
  next wake and keeps its cwd — resume history survives the role change.
- Orchestrators are marked with a **crown icon** (the sidebar button and the per-session badge — unified 2026-08-26; the
  achromatic rule holds: kind is shape, urgency is brightness).
- The host exposes **curated tools** to orchestrator sessions (inspect sessions, read conversations, send instructions,
  `create_session`, `update_session_settings`) plus a **compiled-in app guide** (overview/sessions/orchestrator/approvals/
  settings/updates) — compiled in, not read from `docs/` at runtime, because runtime doc reads are an AGENTS.md-style
  injection surface one level sideways.
- **The permission preset is deliberately inexpressible** in the orchestrator's settings tool schema — an orchestrator
  must not be able to quietly widen another session's approval back door.
- `create_session` acts within scope; settings changes surface as a `settings_changed` event + toast, so the human sees
  what the orchestrator changed the moment it changes it.
- Still open from the original design: showing orchestrator-sent instructions distinctly in the target session's
  conversation view, and a per-session "refuse orchestrator instructions" toggle. Neither is built; they stay on the list.

#### FR-12. Waiting-state display — two urgency levels, separated (the heart of control)

Session state machine:

```
idle → working → (waiting_approval | waiting_input | limited | error) → working → …
```

| State | Meaning | Urgency | Display |
|---|---|---|---|
| `working` | An agent turn is in progress | — | ⚙ spinning |
| `waiting_approval` | **The agent is blocked.** Nothing happens unless I press something | **urgent** | 🔴 (+ elapsed time) |
| `waiting_input` | The turn is over. No harm done if there is no next instruction | not urgent | 🔵 |
| `limited` | Blocked by a usage limit, waiting for the reset time | informational | ⏳ (+ expected reset) |
| `error` | Process error etc. | urgent | ⛔ |

- **`waiting_approval` and `waiting_input` are never merged into the same badge.** Colour, icon, ordering and notification policy are all separate.
- The global counter is split too: **"2 approvals · 3 awaiting response"** (a combined "5 waiting" is forbidden).
- Display layers: ① session row status dot (sidebar) → ② project aggregate → ③ split global counters (pinned at the top of the window) → ④ dock icon badge / OS notification — defaults: approvals and errors notify immediately, awaiting-response is badge only. Instead, **when every session has finished its work (all waiting/idle), one "all done" notification** — the signal someone who left the desk needs is this, not the end of an individual session. (Configurable)
- The **"go to the next waiting item"** shortcut: cycles in priority order approval → error → awaiting response (→ FR-17).
- Show elapsed waiting time ("waiting 3 minutes").

#### FR-13. File attachments / image paste

- **Paste an image** from the clipboard into the input box (the screenshot workflow), **drag and drop** files, and a file picker button.
- Files inside the project are passed as path references (@path mention); external files and images are passed through the adapter in whatever form the tool supports.
- Attachment preview (thumbnail) before sending. Differences in per-tool support are reported by the adapter and reflected as disabled UI.

#### FR-14. Context usage display

- A context gauge in the session header: tokens used / context window (%). Updated from streaming usage events.
- Threshold warning (e.g. at 80%, change the gauge colour + a "compaction/degradation may be near" tooltip).
- Show a marker in the conversation view when compaction (summarisation) happens.
- Where the tool does not give exact numbers, state that it is an estimate (shown with ≈).

### 4.2 Requirements added by the usability review (FR-15 ~ FR-19)

#### FR-15. Inbox (triage view) — the entrance to the core usage loop

- A single list that **ignores** project structure and gathers only the items waiting on my intervention right now.
- Ordering: urgency first (approval → error → awaiting response); within the same urgency, ascending by when the wait started.
- Each item: session name, project, kind of wait, elapsed time, a one-line preview of the last content.
- Select an item → jump to that session's focus view; when handling (approval/response) is complete, **automatically move to the next item**.
- **`d` (dismiss)**: read an awaiting-response item, and if satisfied, archive the session with one key (FR-20). **The first-class means of emptying the inbox** — without it, awaiting-response items keep piling up and the inbox is useless within hours.
- One shortcut to open/close the inbox (default `⌘I`). If there are waiting items when the app starts, show the inbox first.
- If FR-1's sidebar is "the map", the inbox is "the queue of things to do". The entry point when you come back to the desk is the inbox.
- It is the entry point of the §1.3 loop, so it is **in M1 scope**. It is one list, so the implementation burden is small too — it may be needed before the sidebar.

#### FR-16. Read/unread

- **Independently** of session state (working/waiting), track "is there new content since I last looked".
- Store `last_read_seq` per session. Conditions for marking read: when scrolling in the focus view reaches the latest, **or 3 seconds elapse with the session focused** — short responses do not produce scrolling, so without the secondary condition they stay unread forever.
- Show unread on the sidebar session row (weight/dot). "The agent worked alone for 5 minutes and finished" is `waiting_input` + **unread** — both axes have to be visible to avoid missing "a session whose result I have not checked".
- Among awaiting-response items in the inbox, put the unread ones first.

#### FR-17. Keyboard-only operation

The whole control loop must turn without a mouse. The v1 default shortcuts:

| Action | Key |
|---|---|
| Go to the next waiting item (priority cycle) | `⌘⇧A` (provisional) |
| Open/close the inbox | `⌘I` |
| Jump project | `⌘1`~`⌘9` |
| Move between sessions within a project | `j` / `k` (when the input box is not focused) |
| Approve allow / deny / always allow | `y` / `n` / `a` (⌥a: project scope) |
| Archive session from the inbox (dismiss) | `d` |
| Command palette (search projects, sessions, actions) | `⌘K` |
| Focus / leave the input box | `Enter` / `Esc` |
| Switch tab (conversation/files/git/viewer) | `⌘⇧1`~`⌘⇧4` |

- Shortcuts are changeable in settings. Conflict detection.

#### FR-18. Automatic session names

- "Session 1, Session 2" becomes unidentifiable past 4 projects. Default to an **automatic title** based on the first prompt.
- Claude Code already generates its own session title, so take it as is. Tools that do not support it, such as Codex, get the front of the first user message truncated as an initial name.
- Manual renaming stops the automatic updates.

#### FR-19. First-run experience (onboarding)

Three empty states that decide the first impression, designed explicitly:

1. **CLI not installed**: show the per-tool detection result and a button to copy the install command. You can proceed with only one installed.
2. **Not logged in**: on detection, guidance to "run `claude` / `codex login` in a terminal" + a re-detect button after finishing. (The app does not do the login flow for you — it uses each CLI's own keychain authentication.)
3. **0 projects**: prompt for drag and drop + suggest recent directories. Registering the first project through creating the first session as one flow.

#### FR-20. Session archive and record

- Archive = terminate the agent process + remove from the sidebar and inbox. **The conversation record is kept in SQLite.**
- Archived sessions can be viewed in a per-project "Archive" list and from the command palette. Where resume is possible, resume in place (return to active).
- FR-10 (restore on restart) only restores **active sessions** — archives are outside the restore scope.
- Entry points: `d` in the inbox, a session header button, the command palette.

#### FR-21. Conversation content search

- M1: search session names and projects from the command palette (⌘K).
- M2: full-text search of conversation **content** (SQLite FTS, archives included) — "where did we talk about that" is guaranteed to come up with 4 sessions over a few days.

---

## 5. Screen composition

### 5.1 Main layout: sidebar + focus view

Observation (left, dense) separated from operation (right, full width). Not a grid.

```
┌──────────────────────────────────────────────────────────────────┐
│ ⌘ Centralu    [🔴 2 approvals · 🔵 3 awaiting]  [usage] [＋]     │
├────────────────┬─────────────────────────────────────────────────┤
│ ▾ project A    │  auth refactor (Claude · main · ctx 42%)        │
│   🔴 auth ref  │ ┌───────────────────────────────────────────┐   │
│   ⚙ fix tests  │ │                                           │   │
│ ▾ project B    │ │   conversation stream (full width —       │   │
│   🔵 API rev • │ │   it can actually be read)                │   │
│ ▾ project C    │ │  ┌─ approval request ─────────────────┐   │   │
│   ⏳ migration │ │  │ Bash: npm run build                │   │   │
│ ▾ project D    │ │  │ [y allow] [n deny] [a always]      │   │   │
│   ⚙ gen docs   │ │  └────────────────────────────────────┘   │   │
│                │ └───────────────────────────────────────────┘   │
│  (• = unread)  │  [input box + attachments]                      │
│                │  [conversation | files | git | viewer]          │
└────────────────┴─────────────────────────────────────────────────┘
```

- Sidebar: the project/session tree, status dots (🔴 approval / 🔵 awaiting response / ⚙ working / ⏳ limited / ⛔ error / 👑 orchestrator), unread dot, branch and change-count summary. Collapsible.
- Focus view: one session at full width. Bottom tabs switch to the file tree/git/viewer — at full width each tab is actually a usable size.

### 5.2 Inbox (⌘I)

```
┌─ inbox ── 2 approvals · 0 errors · 3 awaiting ──────────────────┐
│ 🔴 auth refactor (A)  Bash approval        4m    "npm run…"     │
│ 🔴 migration (C)      file write approval  1m    "schema…"      │
│ 🔵 API review (B) •   awaiting · unread    12m   "review done…" │
│ 🔵 gen docs (D)       awaiting            25m    "README…"      │
└─────────────────────────────────────────────────────────────────┘
```

- Enter to jump → handle → automatically on to the next item. When the loop is done, "inbox empty ✓".

### 5.3 Secondary screens

- **Usage dashboard**: weekly bar chart (daily), breakdown by tool/model/project, estimated cost, limit window status.
- **Session creation dialog**: tool → model → permission preset → starting prompt. Includes the concurrent-session warning (FR-2).
- **Settings**: tool paths/detection status, default presets, notification policy (per state), shortcuts, theme, **appearance — a 5-step text scale** (2026-08-26; scales the whole surface like an OS display factor, while minimum widths and grid column math stay pinned in real pixels).

### 5.4 Grid view (**experimental**)

Originally excluded from v1. There were three reasons:

1. On a 14-inch screen a 2×2 gives ~600×400px per panel — fit a conversation stream, an input box and tabs in and none of them can properly be seen.
2. It conflicts as an interaction model with the "go to the next waiting item" loop (handle one at a time).
3. The multi-project requirement is satisfied by the sidebar (constant observation) + keyboard switching (immediate operation).

**2026-08-20: the decision changes.** The grid is already built and running — yet this document alone was
saying "we do not build this", and there was no mark on screen either (issue #25). Rather than removing it, **it ships marked experimental.**

Of the three, **1 and 2 still hold as they were.** They are kept here as live reasons, not dead ones:

- **1** — computing the column count from the width (`columnsFor`) at least stopped panels dropping below a minimum width.
  But the grid has **no right-hand evidence panel**: the screen is already divided, and taking another lane
  out of it leaves an unusable width. You can see the conversation but not "was that actually so".
- **2** — ⌘⇧A (go to the next waiting item) picks a session and **puts the screen back to the focus view.**
  A loop that handles one at a time and a screen that shows several at once have not been reconciled yet.
- **3** — still true. What satisfies FR-1 is the sidebar; the grid is **another way of looking**, laid on top of it.

So the mark goes not inside the screen but on **the sidebar's Grid button** (the same prescription as
#1's orchestrator: slate text + a dashed border, using neither colour nor brightness). The reason differs, though — #1 was
trying to stop you pressing without knowing, but the grid is free to press and reversible. What is costly is the
time spent inside it, and the sidebar is never covered while the grid is open, so a single mark covers both **before pressing
and throughout**.

The mark has not frozen the screen: since it went on, the grid gained drag reordering that moves panels as the
same DOM node (conversation scroll survives), a rotating working-border (§7.1's measured cost included it),
and real-pixel column math that holds under the text scale. **Experimental describes the two open objections
above, not the build quality.** To be revisited in v2 as an option for large-monitor users.

---

## 6. System architecture

### 6.1 Process structure

As built, the Rust shell is **thinner** than first drawn and the Node host **owns more** — the shell supervises,
the host does the work, and the UI talks to the host over one WebSocket that is the same in dev and prod
(details in [architecture.md](architecture.md)):

```
┌─────────────────────────── Tauri app (Rust) ──────────────────────────┐
│  · window/tray/notifications      · sidecar supervisor                │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ WebSocket (same protocol dev and prod)
┌──────────────────────────────┴────────────────────────────────────────┐
│                      Node sidecar (Agent Host)                        │
│  · ClaudeAdapter (Claude Agent SDK)   · CodexAdapter (app-server RPC) │
│  · common event normalisation         · orchestrator tools (FR-11)    │
│  · git CLI wrapper (FR-4)             · file tree IO + dir watchers   │
│  · SQLite (~/.centralu/store.db — sessions, messages, workspace)      │
└──────┬──────────────────────────┬─────────────────────────────────────┘
       │                          │
  Claude Code sessions       Codex sessions   (processes exist only while sessions do)
```

### 6.2 The common adapter interface (the heart of extension)

```ts
interface AgentAdapter {
  createSession(opts: { cwd, model?, permissionPreset?, resumeId? }): SessionHandle
  send(sessionId, input: { text, attachments?: Attachment[] }): void
  respondApproval(sessionId, requestId, decision: 'allow'|'deny'|'always',
                  scope?: 'session'|'project'): void
  interrupt(sessionId): void
  dispose(sessionId): void
  // The adapter → app direction is normalised into a single event stream:
  // message_delta | tool_call | tool_result | approval_request
  // | turn_complete | usage_update | context_update | state_change
  // | limit_reached | session_title | error
  events: EventStream<NormalizedEvent>
}
```

- The UI knows only `NormalizedEvent`. Per-tool differences (approval mechanism, usage format, resume mechanism) are absorbed inside the adapter.
- Adapters provide a **capability declaration**: `{ approvals: boolean, contextUsage: 'exact'|'estimate', resume: boolean, autoTitle: boolean }` — the UI enables/disables features from it (e.g. hide the approval UI for a tool that cannot override approvals).
- Adding Gemini CLI etc. in v2 means writing one new adapter and nothing else.

### 6.3 Data model (SQLite)

- `projects(id, path, name, default_tool, default_model, sidebar_order, …)`
- `sessions(id, project_id, tool, external_session_id, name, auto_named, state, is_orchestrator, verbosity, archived, last_read_seq, created_at, …)` — `kind` is derived from `is_orchestrator` + `project_id` (central vs project orchestrator, FR-11)
- `messages(session_id, seq, role, kind, payload_json, ts)` — the conversation cache for restore (+ FTS5 index, M2)
- `approval_rules(scope, project_id?, session_id?, matcher, decision, created_at)` — "always allow" rules
- `usage_facts(date, tool, model, project_id, input_tokens, output_tokens, cache_tokens, cost_est)` — incremental aggregation
- `workspace(id, layout_json, updated_at)` — snapshot

---

## 7. Non-functional requirements

### 7.1 Performance and energy targets ("lightness", given numbers)

| Metric | Target |
|---|---|
| CPU while idle (4 sessions idle) | ≈ 0% (measured < 1%) |
| App memory (4 projects, 4 sessions, excluding agent processes) | < 400MB |
| Cold start → workspace restore complete | < 3s |
| UI frames while streaming | hold 60fps (virtualised list) |
| Energy | keep macOS Activity Monitor energy impact at "Low" (excluding while streaming) |

How it is achieved: event-driven (no polling), **a single focus-view render** (unfocused sessions update only state and unread), lazy file tree, watcher debounce, virtualised conversation list.

**Measured 2026-08-26** (perf suite, `pnpm perf` — WebKit, the production engine): idle browser-process CPU
0.1–0.2% with zero React commits; with sessions *working*, 3.3% (focus) / 4.0% (grid, 4 panels). The working
figures were 24.4% / 32.9% until that day — the spinner animated a conic-gradient's angle through a registered
custom property, which repaints on the main thread every frame; it now rotates a pre-rasterized plate via
transform, owned by the compositor. The lesson is recorded here because it is the standing-load version of the
§7.1 principle: **what the screen does while nothing happens is a battery bill.** The perf suite
(`e2e/perf-idle.spec.ts`, `e2e/perf-grid.spec.ts`) prints numbers, not verdicts.

### 7.2 Other

- **Offline/fault tolerance**: on adapter process crash, move the session state to `error` + one-click restart. On app crash, restore from the snapshot.
- **Security**: we do not handle API keys directly — each CLI's own login (keychain) is used as is. No secrets are stored in the app DB.
- **Platform**: macOS first (the development machine), with the structure kept cross-platform (Tauri).
- **Language**: Korean-first UI, with strings separated so English is easy to add.

---

## 8. Roadmap

**Status 2026-08-26: M0 ✓ · M1 ✓ · M1.5 ✓ · M2 ✓ — M2.5 (dogfooding) is where we are.** The milestone
contents below are kept as written (they record what was decided, and against what); ✓ marks completion.
Shipped during M2.5 so far, driven by real use: the orchestrator redesign (FR-11 — #13, #30), codex verbosity
(#54), external file-tree changes (#34), History as its own tab (FR-4), the 5-step text scale, the sticky
user-message banner, and the standing-render fix measured in §7.1. Of the original M3 list, the orchestrator
and the worktree option are done; the weekly cost dashboard remains open (FR-9).

### M0 ✓ — technical verification spike (short)

- One Claude Agent SDK session streaming E2E from Tauri + a Node sidecar
- The same scenario verified over the Codex app-server protocol
- **Confirm that the permission preset can override the CLI's global setting (bypass) per session** ← the precondition for the approval UI holding together
- Confirm that approval request, usage and session title events actually arrive ← if not, reconsider the integration approach
- Confirm whether Claude Code file checkpoints can serve as the concurrent-session recovery path (FR-2)

### M1 ✓ — MVP (the control loop turning from day one)

- Project registration + sidebar + focus view (FR-1) — not a grid
- Claude Code session GUI conversation + keyboard-first approval UI (FR-3)
- **Inbox + `d` archive (FR-15, 20)** — the entry point of the §1.3 loop; without it the loop does not turn in M1
- Two separated waiting badges + split global counters + "go to the next waiting item" (FR-12, part of 17)
- Automatic session names (FR-18)
- Read/unread (FR-16)
- Inline concurrent-session warning (FR-2)

### M1.5 ✓ — always on (redefined 2026-08-15 — detail in [plans/m1.5-plan.md](plans/m1.5-plan.md))

Of the original four "reliability" items, the context gauge (FR-14) and the limit badge (part of FR-9) were **pulled forward and completed in M1**.
On top of what is left, this milestone also solves what blocks real use (launching 2 terminals by hand, sessions dying when the host does, no notifications).

- Desktop shell: Tauri migration steps 1~3 (sidecar supervision, reuse of the web implementation, system port swap)
- Miss nothing: OS notifications, dock badge, global shortcuts
- Do not get cut off: session resume (FR-10), persistent restore of approval rules, workspace snapshot
- Take the scale: conversation virtual scrolling, message windowing, measured performance
- First-run experience (FR-19)

### M2 ✓ — control completed

- Codex adapter (FR-7 completed)
- Full-text conversation search (FR-21)
- Git panel: Changes/History/Branches + IDE line jump (FR-4), then commit/staging/push (the part settled for v1.5)
- File tree + code viewer (FR-5, 6)
- Attachments/image paste (FR-13)
- Command palette ⌘K, shortcut settings (FR-17 completed), OS notification policy

### M2.5 (in progress) — improvements after using it myself

After building through M2, run it on a real project for a few days and work the complaints that come out of that as a backlog.
This is the one point where a human judges (decided 2026-08-15, see plans/m1.5-plan.md).

### M3 — intelligence

- Weekly usage **cost** dashboard (FR-9 — the limit-window view shipped earlier; the cost view is what remains)
- ~~Orchestrator session~~ (completed 2026-08-25 during M2.5, redesigned — see FR-11)
- ~~Worktree option~~ (completed 2026-08-19 — FR-2's lower-priority option), per-project default presets, ~~performance tuning~~ (§7.1 measured 2026-08-26)

---

## 9. Risks and responses

| Risk | Impact | Response |
|---|---|---|
| **The permission preset cannot override global bypass** | The approval UI (a core feature) is neutered | Top-priority M0 verification. If impossible, disable the approval UI per tool via the capability declaration and rebuild the inbox around awaiting-response |
| The Codex protocol changes between versions | Adapter breakage | Version detection in the adapter + protocol snapshot tests, verified early in M0 |
| The SDK may not give enough context/usage detail | FR-14 accuracy | Demote to 'estimate' via capability + show ≈, with log parsing as backup |
| File conflicts between concurrent sessions in the same directory | **Data loss** | An explicit warning dialog at creation time + a same-file-modification detection badge (FR-2), worktree option later |
| Situations where resume is impossible (tool update, lost logs) | FR-10 degraded | Design the "view the record + new session" fallback as a first-class path |
| The orchestrator running away (excessive instructions) | Cost and confusion | Instructions made visible + per-session refusal + a `create_session` proposal card + respecting the approval preset |

---

## 10. Open questions (next to be decided)

1. How the unit price table for usage cost estimation is maintained (hardcoded vs a locally updatable table)

### Closed questions (decided in v0.4)

- Git commit/staging → **goes into v1.5** (right after the read panel is finished, as an extension of the same panel). Advanced operations such as rebase remain non-goals.
- Weekly usage data source → **stay with log parsing** (confirmed that the SDK only gives per-turn usage for its own sessions, with no weekly aggregation or plan limit API — see FR-9).

- Front end → **React**. Idle energy is decided by the render policy (§7.1), so framework lightness is not the deciding factor; ecosystem and agent-driven-development friendliness take priority.
- Orchestrator `create_session` → **proposal card + human confirmation** (the three inspect/read/send tools are automatic).
- "Always allow" rules → **patterns allowed + a match preview at registration + rule management in settings**. Make the consequences visible instead of limiting expressiveness.
- `waiting_input` notification → **silent by default (badge only), with one "all done" notification when every session has finished its work**.

---

~~**This document is the last revision before the M0 spike.**~~ M0 came and went without shaking §2's premises,
and the code ran ahead of the document for ten days — far enough that the paper said "we do not build this"
about things that were on screen (the grid, #25; then the terminal). **v0.5 (2026-08-26) realigns the document
to the implementation.** The standing rule from here: when screen and paper disagree, either the screen carries
a mark (experimental) or the paper gets a strike-through with a date — the disagreement itself must never be silent.
