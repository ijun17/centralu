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
| Orchestrator session | A session with `kind: 'orchestrator'` — able to inspect and instruct every session in the app. Exactly one, belonging to no project. A project's own directing seat is the worktree manager, which is defined by having worktree children rather than by a role (FR-11, #69) |
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
- **Approval requests from unfocused sessions**: the inbox counter in the top bar carries them — it says how many are waiting, its list names them, and clicking one lands you on that session, where the card is answered with y/n/a. There was a global banner across the top of the window that let you allow in place (with a "needs review" state for requests the strip could not show enough of: file edits, multi-file operations, truncated commands). It was removed 2026-09-10: appearing and disappearing **shifted the whole window**, and the line you were reading — or the button you were reaching for — moved with it. An alert that displaces the work it interrupts costs more than the jump it saves.
- **Approval queue**: when several approvals pile up, handle them in sequence from the inbox (FR-15). Handling one leaves the person on that session; `⌘⇧A` moves to the next waiting one.
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

- **Kind is an explicit marker**, not a null check: a session is `kind: 'orchestrator'` or a normal session. There is
  exactly one orchestrator, and it belongs to no project — it reaches every session in the app (an `inScope` predicate
  guards every tool call).
- The orchestrator is marked with a **crown icon** on its sidebar button (the achromatic rule holds: kind is shape,
  urgency is brightness).
- **Retired (2026-09-01): the per-project orchestrator, and with it promote/demote (`sessions.setKind`).** #13 built a
  three-tier hierarchy (central > project > session) on the reasoning that one conversation cannot hold every project's
  context. The worktree manager (#69) then arrived and took the same seat from a different direction — a session that
  directs a project's sessions — and having two of those was one concept too many: the app's own author confused them
  in dogfooding, and the promote row was never used once. What survives is the pair that earns its keep: one
  orchestrator across everything, and a manager per project whose scope comes from a **relationship** (it has worktree
  children) rather than from a menu choice. Schema v26 clears the marker off any session that still carries it with a
  project — without that step, removing the project tier would silently *widen* those sessions to central scope.
- The host exposes **curated tools** to orchestrator sessions (inspect sessions, read conversations, send instructions,
  `create_session`, `update_session_settings`) plus a **compiled-in app guide** (overview/sessions/orchestrator/approvals/
  settings/updates) — compiled in, not read from `docs/` at runtime, because runtime doc reads are an AGENTS.md-style
  injection surface one level sideways.
- **The permission preset is deliberately inexpressible** in the orchestrator's settings tool schema — an orchestrator
  must not be able to quietly widen another session's approval back door.
- Settings changes surface as a `settings_changed` event + toast, so the human sees
  what the orchestrator changed the moment it changes it.
- Orchestrator-sent instructions are marked in the target session's conversation (built 2026-08-26): a source label
  above the bubble and a dashed border — shape, not color, per the palette rule. Worker completion reports in the
  orchestrator's own chat carry the same marker. The sticky banner prefixes the source name.
- **Dropped (2026-08-27): the per-session "refuse orchestrator instructions" toggle.** It was written into v0.4 as the
  other half of that safeguard sentence, never requested and never missed: the person who creates the orchestrator and
  chooses its scope is the same person who would flip the switch, so refusing your own control tower has no situation
  behind it. Same rule the adapters follow — build it when a real instance is observed, not because a design sentence
  once paired it with something else. (Shared-operator setups would change this; that is not what this app is.)

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
- Select an item → jump to that session's focus view. When handling (approval/response) is complete, the person **stays on that session**, so they can see how the agent takes what they just sent; `⌘⇧A` (FR-17) moves to the next waiting item. *(Changed 2026-10-02: this used to say the app moves to the next item automatically. Nothing did since the archive's `d` key and its `afterHandled` path were retired with FR-20, and the owner chose to keep it that way: a screen that switches the moment a reply is sent is hard to predict.)*
- ~~**`d` (dismiss)**~~ — **retired 2026-09-02.** It archived the session, which was the only entry point archive ever had and had no exit; "I do not need to answer this" removed the session from the app. The inbox is a view of *state*, so the only honest way to empty it is to change the state — that is, to answer. See FR-20.
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
| Command palette (search projects, sessions, actions) | `⌘K` |
| Focus / leave the input box | `Enter` / `Esc` |
| Switch tab (conversation/files/git/viewer) | `⌘⇧1`~`⌘⇧4` |

- Shortcuts are changeable in settings. Conflict detection.

#### FR-18. Automatic session names

- "Session 1, Session 2" becomes unidentifiable past 4 projects. Default to an **automatic title** based on the first prompt.
- Claude Code already generates its own session title, so take it as is. Tools that do not support it, such as Codex, get the front of the first user message truncated as an initial name.
- Manual renaming stops the automatic updates.

#### FR-19. First-run experience (onboarding)

**Orchestrator-first** (#63, 2026-08-27 — replaces the folder-first flow). The goal is habit
formation, not efficiency: someone who never asks the orchestrator anything on first run
will not press it later either, and questions about the app should land on the orchestrator
rather than on the maintainer. Exactly two stops, no wizard:

1. **Intro screen** (shown once, to a truly virgin install — no projects and no sessions):
   a one-line statement of what the app is, a prominent one-or-two-sentence explanation of
   the orchestrator's role, and two large agent cards (Claude Code / Codex). **The cards are
   the tool detection display**: a ready tool is an active card; a tool that is not ready is
   dimmed and disabled with "Not connected" and the specific remedy inside (install command
   vs. login command — the app does not do the login flow for you), plus a re-detect button.
   Clicking a ready card stores which tool the orchestrator will run on ("you can change
   this later" is stated on screen) and advances. It does **not** start any process.
2. **The normal orchestrator session view**, empty. While the conversation has 0 messages,
   three large action-oriented suggested questions are shown (create a project / what can
   the orchestrator do / how to run several sessions) plus an always-available escape hatch
   ("or just pick a folder" → native picker → session-creation dialog). Clicking a question
   **sends it immediately** — that click (or the first typed message) is what actually
   spawns the orchestrator process (lazy spawn). The suggestions are a function of message
   count, not an onboarding state machine; the composer, sidebar and grid stay fully usable.

The project-creation answer ends in an action: the orchestrator's `propose_project` tool
renders a proposal card whose only power is to open the **native picker for the human** —
the tool itself cannot register a folder (propose-not-power; see §FR-11 security notes).

#### FR-20. Session archive — **retired (2026-09-02)**

Archive is gone: the flag, the RPC, the orchestrator's `archive_session` tool, and the `d`
key. Schema v28 drops the column, so nothing is hidden any more.

What was built was half of what is written above this line: the way in (`d` in the inbox)
without any of the ways out (the per-project Archive list, the palette, resume in place).
So a key labelled "Dismiss" removed a session from the sidebar, the palette and the inbox
with no path back — indistinguishable from deletion, and reachable by one keystroke. An
agent could do it too, through `archive_session`.

The stated purpose was to empty the inbox. That is the category error: the inbox is a view
of session *state*, and "I do not need to answer this" is not a state the agent can be in —
so the key had no lever except removing the session from the set entirely. Emptying the
inbox now means answering, which is the thing the inbox exists to prompt.

Nothing needed archive to keep a record: deleting a session already says the conversation
survives in Claude/Codex and can be pulled back from **+ → Past conversations** (there is a
host test that holds that promise). If the sidebar ever does get crowded — worktree sessions
are the plausible source — the answer belongs where the crowding is (collapsing merged
children), not in a global hidden state.

**Since 2026-09-30 a hidden-but-kept session exists again: the trash (FR-22, #204).** It is the
shape retired here, built with what archive lacked. The way out ships with the way in (list, read,
restore, delete for good, in Settings); deleting is not one keystroke but a dialog that says where
the session goes and how it comes back; no agent or app can take a session out of the trash or
delete one for good; and the trash is emptied by nothing but the person.

#### FR-21. Conversation content search

- M1: search session names and projects from the command palette (⌘K).
- M2: full-text search of conversation **content** (SQLite FTS) — "where did we talk about that" is guaranteed to come up with 4 sessions over a few days.
- **Content is what was said**: the person's words, the agents' answers and their reasoning. Tool calls and their output are not searched ([#221](https://github.com/ijun17/centralu/issues/221)). Commands were indexed until then, and they were 55,131 of 81,816 index rows and most of a 124.5MiB index in a 236.2MiB store (a copy of the real one, 2026-09-30); a command's output never was. Taking them out cost nothing a search for what was said finds (all 397 sampled queries returned the same messages) and left a 36.6MiB index in a 145.4MiB store. What a session ran is read with `read_session`, not searched.
- Sessions in the trash (FR-22) are **not** searched, by the person or by an agent's `recall`: their index rows are dropped when they go to the trash and rebuilt when they come back.

#### FR-22. Session trash (2026-09-30, [#204](https://github.com/ijun17/centralu/issues/204))

Deleting a session moves it to the trash. A conversation leaves this machine only when the person
deletes it for good in **Settings → Trash**, one at a time or all at once. The reason is the
owner's: conversations are important data, and one click in the delete dialog used to destroy one
with no way back.

- **What goes to the trash** is everything deleting used to destroy: the session row, its messages,
  its approval rules, its commit links (`commit_sessions`), the app runs that point at it (with their
  token counts), its attachments and its handoff note (`<data>/handoff/<project id>/<session id>.md`).
  Its search index is the exception — dropped, not kept, which takes it out of every search and
  frees the larger half of what it took (the index was 71MB of a 137MB store measured for #96).
- **Files outside the database stay where they are**, and the delete dialog's two choices say what
  goes with the session when it is deleted for good:
  - *the tool's conversation file* (Claude JSONL, Codex rollout) stays where the tool keeps it. It is
    the tool's file in the tool's layout, and only the tool's own delete knows that layout; left in
    place it is also a second way back (the tool, and **+ → Past conversations**, still have it). If
    a live session has pulled the same conversation back meanwhile, deleting for good leaves the file.
  - *the worktree* stays in place and registered with git. Moving a worktree folder leaves git's
    record pointing at nothing (`git worktree list` calls it prunable, and `prune` or a `gc` then
    drops the record), and Claude files a conversation by its working directory, so a moved worktree
    would lose the restored session its own history too.
- **Out of reach while trashed**: the sidebar, inbox, palette, grid, project screen (§5.5), conversation search (FR-21), the
  orchestrator's `list_sessions` / `recall` / `read_session`, the apps' `host_data` `sessions.list`,
  and the approval rules list in Settings. Every store query that reads sessions has to say what it
  does about the trash; a host test fails on one that does not.
- **The way back**, in Settings → Trash: each session with its name, project, when it was deleted,
  its size, and what else goes with it; read it (read-only); restore it; delete it for good; empty
  the trash. The total size is shown, because nothing empties the trash on its own.
- **A restored session comes back as it was**: same id, messages, rules, commit links and app runs,
  its index rebuilt; a live-only state (working, waiting for approval) comes back idle, as after a
  restart. If its project was deleted meanwhile, restoring registers the folder again under the same
  project id — so the worktree folder, the handoff notes and the rows kept with the session line up
  again — or joins that folder if it was added again under a new id. If the folder is gone too,
  restoring refuses and says where the folder was; the session stays readable in the trash.
- **Deleting a project moves its sessions to the trash** instead of destroying them — the largest loss
  one click could cause. Nobody is asked about their tool files or worktrees then, so those stay even
  when the trash is emptied. The project's own rows (project-scope rules, usage totals, answers given
  to its apps) go with the project as before.
- **Nobody but the person deletes for good.** The trash is reached only through the UI's RPC; the
  agents' tools and the apps' broker have no verb for it. An agent can put a session in the trash (the
  worktree manager's cleanup of a proven-merged worktree does), never take one out of it.
- Schema v39 adds `sessions.deleted_at` (NULL for a live session) and `sessions.trash` (JSON: where it
  came from, and what to remove when it is deleted for good). A trashed session has no `project_id`;
  its project is in `trash`, which is what lets its project be deleted without the foreign key taking
  the session with it. Later migrations have to consider rows that belong to a trashed session.
- Not covered: attachments of a trashed session stay under the same 500MB attachment cap as every
  attachment, and app runs pointing at it under the app-run retention.

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
  - **Which project is open** (2026-10-01). A thin divider separates each project's group — its name row, its
    sessions and its apps — from the next. While the focus view shows a project's screen (§5.5) or one of its
    sessions, or the app view shows one of its apps (2026-10-03), that project's whole group is tinted with the graphite of the selected Grid and Orchestrator
    buttons, lighter, and the open row inside it keeps a stronger mark of its own (the ash bar): the name row for
    the project screen, the session's row for a session, the app's row for an app. A row mark alone says "this row"; the tint says whose, and
    it is the only mark a folded project (#205) has room for. The grid, the orchestrator, a session with no
    project and an app in the user folder tint nothing — none of them is a project. Both layers are colour only, so selecting moves no row.
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

- Enter to jump → handle → `⌘⇧A` on to the next item. When the loop is done, the inbox reads "Nothing waiting".

### 5.3 Secondary screens

- **Usage dashboard**: weekly bar chart (daily), breakdown by tool/model/project, estimated cost, limit window status.
- **Session creation dialog**: tool → model → permission preset → starting prompt. Includes the concurrent-session warning (FR-2).
- **Settings**: tool paths/detection status, default presets, notification policy (per state), shortcuts, theme, **appearance — a 5-step text scale** (2026-08-26; scales the whole surface like an OS display factor, while minimum widths and grid column math stay pinned in real pixels), **trash** — deleted sessions to read, restore or delete for good, with the total size (FR-22).

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

### 5.5 Project screen (2026-09-30, [#203](https://github.com/ijun17/centralu/issues/203))

Clicking a project's name in the sidebar opens its screen (the name opens it; the arrow beside it
folds the project's rows, #205). The screen shows **everything the project has — its sessions and its
apps — as panels**, laid out and moved the way the grid's are.

| Decision | Why |
|---|---|
| **Everything appears on its own**; nothing has to be put here by hand | The screen is "this project", not a selection from it. One that waited to be filled would be empty the first time it is opened, which is the one time it has to explain itself. |
| New panels land **at the end**; panels nobody has placed follow the placed ones in the sidebar's order | A panel pushing into the middle of an arrangement someone made moves every panel after it. |
| A panel can be **hidden** (×, the session keeps running); hidden panels are named above the panels, and one brought back by its name lands at the end | Hidden is not deleted, and a panel that left with no trace is one nobody remembers hiding. Its old place is a memory of a screen that has changed since. |
| **The project's sidebar rows can be dropped here**, the way sessions are dropped on the grid — its sessions and its apps. A hidden one comes back where it lands (before or after the panel under the hand, or at the end on the padding); a visible one moves there, and dropped on the padding stays where it is. The order is remembered like a dragged panel's | Bringing a panel back to the place it is wanted is one gesture instead of two (show, then drag), and the grid already taught the hand this one. The padding rule is the grid's, for a session already on it. |
| **Only this project's**: another project's session or app, and the orchestrator, are refused while still being dragged — no drop cursor — and a drop that arrives anyway is ignored | The screen is one project, whole; a panel from another would make it a selection, which is the grid's job. The refusal has to show before the hand lets go, or the drop reads as broken. A page can read a drag's types but not its data until the drop, so the project goes in a type of its own (`application/x-cc-of-project.<id>`); the drop checks the data again, and an app by its key, which carries its project — two projects can each have an app with the same id. |
| What is remembered, **per project and across restarts**, is only the dragged order and the hidden set, in the workspace snapshot beside the sidebar fold | It is a way of looking at one project, read and written only by the UI; the host acts on none of it. Its panels are sessions *and* apps, which a table keyed to sessions (the grid's `grid_panels`) cannot hold without cleanup rules of its own for apps, and what that table buys — a panel leaving with its session — comes here from deriving the panels from what exists. Deleting a project drops its arrangement. |
| A session in the trash (FR-22) is never a panel; one restored comes back at the end | The panels are derived from the session list, and a trashed session is not in it — a remembered order naming it shows nothing. |
| **An app's panel is its pinned view** (apps.md §6.2): the same instance in the same frame; Open goes to the app view; × closes the view, teardown first. While one of the project's rows is dragged in from the sidebar, the views are hidden, not unloaded | An iframe that moves loses its document, and one instance must have one frame. The view is laid over the panel instead of drawn inside it, so going between this screen, the app view and a session keeps one document. The header's Runs, Secrets, Versions and Builder open side panels a panel has no room for, so they stay in the app view. Showing an app here opens it (the host calls `home`), inside trust and import confirmation as always. In WebKit a drag goes into a frame whatever the frame's pointer-events say (measured in Playwright's WebKit), so a row dropped on an app's view would land in the app instead of beside it. |
| **The grid is unchanged** | It stays a hand-picked list across projects. A session can be on both; a session's panel dropped on the Grid button goes onto the grid, like a sidebar row. |
| The **evidence panel stays** beside it, unlike the grid | One project, one repository: objection 1 of §5.4 does not apply. Columns come from the width that is left (`columnsFor`), so no panel goes below the minimum either way. |

The panels share the grid's parts: `SessionPane`, the column count, the whole-pixel tracks and the
working ring (#208), and the settings that fold the message box and stop the ring. A session that
finishes in a visible panel gets the breeze, not a card. A panel does not take the session focus, so
typing in one does not leave the screen; objection 2 of §5.4 holds here too — ⌘⇧A and the inbox open
the focus view. A project with nothing in it says so and offers a new session; one whose every panel
is hidden asks, in the empty grid's words, for its sessions and apps to be dragged in from the sidebar.

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
- `sessions(id, project_id, tool, external_session_id, name, auto_named, state, is_orchestrator, verbosity, last_read_seq, created_at, deleted_at, trash, …)` — `kind` comes from `is_orchestrator`, which only the app's single orchestrator carries (FR-11). `deleted_at` is set while the session is in the trash (FR-22, v39), and every listing filters on it
- `messages(session_id, seq, role, kind, payload_json, ts)` — the conversation cache for restore (+ FTS5 index, M2). One row is one **message**, not one streaming delta (#66): the open message's row is updated in place while streaming (periodic flush) and indexed once when it closes. It closes at a recorded event, at the end of a turn, at a switch between answer and reasoning, and at a chunk that names a different message than the open row (`messageId`, #212: codex can say two things in a row with nothing recorded between them). Reads merge legacy per-delta rows, so pre-migration data behaves identically. A tool call is kept whole (#221, v40): its `summary` (the card) plus the raw `input` and the whole `output`, which only the store keeps — readers get the card unless they ask for the record by name, and the index holds only `text` and `reasoning` rows (FR-21; [security-boundaries.md](security-boundaries.md#tool-output-in-the-store)). Rows written before v40 have the card alone.
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

**2026-09-25: M4 (apps) is under way beside M2.5** — see M4 below.

### M0 ✓ — technical verification spike (short)

- One Claude Agent SDK session streaming E2E from Tauri + a Node sidecar
- The same scenario verified over the Codex app-server protocol
- **Confirm that the permission preset can override the CLI's global setting (bypass) per session** ← the precondition for the approval UI holding together
- Confirm that approval request, usage and session title events actually arrive ← if not, reconsider the integration approach
- Confirm whether Claude Code file checkpoints can serve as the concurrent-session recovery path (FR-2)

### M1 ✓ — MVP (the control loop turning from day one)

- Project registration + sidebar + focus view (FR-1) — not a grid
- Claude Code session GUI conversation + keyboard-first approval UI (FR-3)
- **Inbox (FR-15)** — the entry point of the §1.3 loop; without it the loop does not turn in M1
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

### M4 (in progress) — apps: the place a tool is built is the place it is used (detail in [plans/apps-plan.md](plans/apps-plan.md))

Its own milestone after M3, which stays as it is (decided 2026-09-25). The goal: an agent builds a tool for the work at hand
**together with its screen**; the person presses it where it was made and asks for a change in the same place; agents call
the same tool as a function. One tool, not a screen and a function built twice. It is judged by dogfooding at the end of C:
a tool built before but left unused because of installs and setup is rebuilt this way, and a non-developer opens it without
being told how.

Apps are MCP servers and their screens are MCP Apps views, standard as far as the standard goes — what the code does is in
[apps.md](apps.md).

In:

- **A. Runtime** — the manifest; apps in the project (`.centralu/apps/`, committed with the repository) or the user folder;
  started when first needed, stopped when idle; one call path with tool visibility and run records; attached to Claude and
  Codex sessions; approved MCP servers absorbed as apps; one list with the built-in apps; project trust, shared with #92
- **B. Views** — inline under the tool card that called it (the standard's own place, where apps built for other hosts work),
  pinned in the main area (the host calls the app's home tool), the sandbox proxy with an opaque origin, change notifications
  to open views, a skeleton while starting and the reason when it fails, a runs panel
- **C. Build loop** — the New app button and `create_app`; a builder session per app; `check`, so the builder tests its own
  app instead of the person; a restart when the builder's turn ends; a "fix it here" bar under the view; errors handed to the
  builder only by the person's click
- **D. Broker** — an app asks, through the host, for the person's agent, another app's tools or host data; capability approval
  on first use; limits on chains and rates; cancellation and records that follow the chain

Light: **E. Handing over, the local half** — snapshots for apps outside git, a confirmation screen when importing, a
`centralu://` deep link. An app committed with the project is already shared with the team.

Out: the team server (permissions, distribution, central run records — the paid boundary); an app marketplace; apps waking
up by themselves (timers, watchers — the broker refuses a call that no run started); also a process sandbox for app servers,
handing the builder a capture of the view, and moving the control app to the new format.

---

## 9. Risks and responses

| Risk | Impact | Response |
|---|---|---|
| **The permission preset cannot override global bypass** | The approval UI (a core feature) is neutered | Top-priority M0 verification. If impossible, disable the approval UI per tool via the capability declaration and rebuild the inbox around awaiting-response |
| The Codex protocol changes between versions | Adapter breakage | Version detection in the adapter + protocol snapshot tests, verified early in M0 |
| The SDK may not give enough context/usage detail | FR-14 accuracy | Demote to 'estimate' via capability + show ≈, with log parsing as backup |
| File conflicts between concurrent sessions in the same directory | **Data loss** | An explicit warning dialog at creation time + a same-file-modification detection badge (FR-2), worktree option later |
| Situations where resume is impossible (tool update, lost logs) | FR-10 degraded | Design the "view the record + new session" fallback as a first-class path |
| The orchestrator running away (excessive instructions) | Cost and confusion | Instructions made visible (source label, built) + a `create_session` proposal card + respecting the approval preset. Per-session refusal was dropped — see FR-11 |

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
