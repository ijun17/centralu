# M2 Plan — Control Completed (v2)

> The bar: **can the person judge what the agent did from inside the app.**
> Through M1.5, "when does it call me" got solved. M2 solves "what do I need to see to answer the call."
>
> Precedes from: [m1.5-result.md](m1.5-result.md) · Verification protocol: [m1.5-plan.md](m1.5-plan.md)
>
> **v2 (revised after independent review, 2026-08-15)**: v1 got a REVISE verdict from an independent review.
> Corrected: 3 factual errors (the state of GitPort, FsPort and FR-7 in code), 1 spec violation (push),
> numerous omissions (the tab shell, migrations, 5 missing shortcuts, the notification policy, FR-2
> recovery), and 2 critical misses (not recognizing the achromatic-vs-diff conflict, and putting the
> bundling spike dead last).

## What is blocking things right now

M1.5 made it possible to leave the app running. But trying to actually use it, **the screen has no basis for judgment**:

| What blocks it | What happens now |
|---|---|
| Cannot see what changed | Approving requires seeing the diff, but the app has only a one-line command, so it means dropping out to the IDE |
| Cannot use Codex | The person actually uses two tools, and the app only knows one (FR-7 unfinished) |
| Cannot find a past conversation | "Where did we talk about that" starts happening as soon as there are more than a few sessions |
| Cannot paste a screenshot | The common flow of showing the screen and giving instructions is blocked |
| No release build | Dogfooding has to happen through the `.app`, but only dev mode has been verified |

## Spec-promise comparison table (product-spec §8 M2 ↔ this plan)

| What the spec promised for M2 | Where it lands in this plan |
|---|---|
| Codex adapter (FR-7 complete) | A + **model/permission preset UI (A-3)** — tool selection alone does not finish FR-7 |
| Git panel + IDE line jump, commit/stage/**push** right after | B (push included — corrects what the v1 plan dropped against the spec) |
| File tree + code viewer (FR-5, FR-6) | C |
| Attachments / pasting images (FR-13) | D |
| Full-text conversation search (FR-21) | E |
| Command palette ⌘K, shortcut settings (FR-17 complete) | E + **the 5 unimplemented shortcuts (E-3)** — the settings screen alone does not finish FR-17 |
| OS notification policy | **E-5** — M1.5 only implemented the default policy, with no settings screen |
| (carried into M2 from m0-findings) revisit the FR-2 recovery path | **B-8** |

---

## Order and reasoning

"Riskiest first" applies to the plan itself too. v1 put bundling — the one thing verified 0 times
— dead last. This corrects that.

```
F-0 bundling spike ─┐(parallel)┌─ A Codex adapter
                    └──────────┴→ B git panel → C tree/viewer → D attachments → E search/palette/settings → F release wrap-up → G doc alignment
```

1. **F-0 spike** — the **single biggest unknown** deciding whether M2 reaches its goal (a dogfoodable
   state) is sidecar bundling. If it fails, the premise behind A through E (keeping the Node sidecar)
   comes into question, so it is checked first, in parallel with Codex.
2. **A Codex** — the real-world test of the design's promise ("just add one adapter"). Protocol risk is low thanks to M0.
3. **B git panel** — the biggest control-tower value. The basis for approval judgment.
4. **C → D → E** — built on the foundation B creates (tab shell, CodeMirror, migrations).
5. **F release wrap-up → G doc alignment**.

---

## F-0. Sidecar bundling spike (1-day box, parallel with A)

Stated precisely, the current state is this: `host_command()` returns **only the dev path**
(`sidecar.rs` — the comment saying "runs as a bundled binary" is not yet true), `tauri.conf.json`
has no `externalBin`/`resources`, better-sqlite3 is a native addon (`.node`), and `store.ts` reads
`schema.sql` via a **path relative to the source tree**. All four break in a release build.

- **F-0a. Decide on a bundling approach** — candidates: ① Node SEA (worst fit for the native addon —
  `.node` needs bundling separately) ② requiring system Node ③ compiling with Bun. **Since dogfooding
  is limited to my own machine, ② stays open as a fallback** — if it comes to ②, that is the cheapest
  path that does not block M2.
- **F-0b. Bundle and launch a hello-world host inside a `.app`** — up through the `host_command()`
  prod branch, wiring up `externalBin`, and bundling (or inlining) `schema.sql`: this passes once a
  minimal host prints its ready line from a `.app` on a clean path.
- Done: the spike results (the choice made, the reasoning, the traps found) are recorded in the
  result document. **If this stalls, report immediately** — it is a product-premise problem that
  cannot be handed off to an automated gate.

## A. Codex adapter (FR-7 complete)

M0 already confirmed the protocol, the type generator and the approval override ([m0-findings.md](../spikes/m0-findings.md)).

- **A-1. Commit the protocol bindings** — the `pnpm codex:bindings` generator script + committing the bindings + a CI check that they are current.
- **A-2. Implement CodexAdapter** — stdio JSON-RPC, `initialize` → `initialized`, `thread/start`
  (approvalPolicy override), `turn/start`, `turn/interrupt`, `thread/resume`. Event conversion
  follows the m0-findings §B table exactly.
  - **Calling out a protocol prerequisite**: the `compaction` event type does **not yet exist** in
    NormalizedEvent — add it to the protocol and wire it through the core reducer and the UI marker
    (this is the unimplemented part of FR-14; exclude it from the A-4 verdict).
  - Done: contract tests (recorded fixtures → NormalizedEvent snapshots), the 6 approval decision
    types mapped (`acceptForSession` = "always allow, session"), capability declaration
  - Done: **zombie check** — spawn a Codex process, then SIGKILL the host and confirm 0 survivors
    with `pgrep` (ties the M1.5 defect-1 regression rule directly to a task)
- **A-3. Session-creation dialog (the rest of FR-7)** — tool → **model → permission preset** → start prompt.
  Right now `permissionPreset: 'normal'` is hardcoded and model is not passed at all (the protocol
  field and the `projects.default_model` column both already exist and go completely unused).
  - Done: E2E — the chosen tool, model and preset reach the host through the `createSession` parameters
  - Done: reading and writing per-project defaults (`default_tool`, `default_model`)
  - Done: disabling uninstalled tools — detection calls `agents.detect` **every time the dialog
    opens** (the same path as M1.5 E-1's re-detect button)
  - Done: E2E — running Claude and Codex sessions concurrently in the same project, distinguished in the sidebar
- **A-4. Verify the design's promise (criteria rewritten)** — v1's "0 diff in ui, core and protocol"
  was self-contradictory (A-2 and A-3 touch all three). The correct criteria:
  - Classify changes outside `adapters/codex/**` into two kinds and record them:
    ① **changes that were unavoidable to attach the adapter** (= evidence the design fell short, a
    reason to revise the design document)
    ② **changes that came from Codex bringing a new feature along** (the compaction marker, the tool
    selection UI, and so on — expected)
  - Done: the classification is recorded in m2-result. If any ① exists, done requires also revising architecture.md §C3.
- **A-5. Real-session smoke** (L3) — S9 (approval round trip, including acceptForSession), S10
  (thread/resume), S11 (running concurrently). Model: Codex's default model (top-tier forbidden).

**Gate**: F-0 passes + the Codex real-session approval and resume pass → proceed to B.

## B. Git panel (FR-4)

- **B-0. Focus-view tab shell (new)** — a prerequisite for all of B and C that was missing from v1.
  The app currently has no concept of tabs at all. A tab container for conversation/files/git/viewer
  + `⌘⇧1~4` switching + restoring `WorkspaceSnapshot.tab` + an empty-tab state.
  - Done: E2E — switching tabs, restoring tabs after a restart, and adding the tab shell to the L5-2 screenshot baseline
- **B-1. Create GitPort (v1 error corrected: this is not an "extension" — GitPort does not exist yet)** —
  the only git support today is the one summary field, `ProjectPort.gitStatus`. Work: create a new
  `GitPort` interface in ports + a `Platform.git` field + 5 protocol RPCs
  (`git.status/diff/log/commitDetail/branches/checkout`) + the rpc handler + expanding
  `dev-services/git.ts` (currently 27 lines) + web/mock implementations + contract tests.
  - Done: run the same contract tests against both the web and mock implementations (tauri reuses
    web, so it is automatically covered)
  - Done: abnormal paths are safe — not a repo, a huge diff (tens of thousands of lines), binary
    files, a detached HEAD, and mid-merge state
- **B-2. Changes tab + diff view** — **introduce CodeMirror (merge view) here, lazy-loaded**, and
  **a bundle-regression test (CodeMirror absent from the initial bundle) is also part of B-2's done
  criteria** (v1 put this under C-3, which would have let bundle contamination go unnoticed for the
  whole of B). The watcher refreshes on file changes (debounced).
  - **Applying the achromatic decision**: diff is shown not with colour but with **2 steps of
    background lightness + `+`/`-` marks**. The achromatic gate in styles.test.ts (all CSS R=G=B)
    stays as is, but strengthens `.find()`, which used to check only one CSS file, into **walking
    every CSS chunk** (so a lazy-loaded chunk cannot slip past the gate).
  - Done: E2E diff rendering + virtual scrolling for a huge diff, L5-2 baseline, L5-3 contrast check
  - Done: with the watcher running (4 projects), idle CPU < 1% (the §7.1 bar, sampled over 10
    seconds) + the FSEvents handle count recorded
- **B-3. History tab** — the commit log + clicking a commit shows its changed files and diff. No graph lines are drawn (parent relationships only).
- **B-4. Branches tab** — the **local/remote** list (v1 dropped remote), current branch, checkout.
  For checking out with a dirty state: the spec's wording says "warn, then stop," but following the
  philosophy ("do not block, make visible") this instead **shows the files expected to conflict and
  asks whether to proceed** — a decision that departs from the spec, so it is recorded in the decisions list.
- **B-5. IDE line jump** — ⌘-click in the diff or file list → `openInIde(path, line)` (reuses the existing SystemPort implementation).
- **B-6. Staging, commit, push** — exactly what the v1.5 spec already locked in (the v1 plan wrongly
  dropped push — the "§1.5" it cited does not exist; that was a misreading of a version label).
  Rebase and cherry-pick remain non-goals.
  - Done: stage/unstage, commit message, commit, and **push** (limited to branches with an upstream, showing the raw error on failure)
- **B-7. Distinguishing agent changes + persisting touchedPaths** — "files the agent touched" is
  **file-level** (`files_touched` only gives paths — explicitly not hunk-level). Right now
  `touchedPaths` lives only in UI memory and **is lost on restart** — since restarts are routine in
  an always-on app, persisting it comes first.
  - Approach: a `sessions.touched_paths TEXT` column (requires migration E-0 first) — reconstructing
    it from messages was rejected because it conflicts with windowing (D-2)
- **B-8. FR-2 recovery path (carried into M2 from m0-findings)** — "view this file's previous
  state" when a same-file conflict is detected. 1st pass: the pre-change content left in the
  tool_call event. With the git panel now in place, this is the cheapest point to add a diff comparison.

## C. File tree + code viewer (FR-5, FR-6)

- **C-1. Complete and wire up FsPort (v1 error corrected)** — FsPort exists only as a definition, has
  no `watch`, and **is not even connected to Platform** (an orphaned type). Work: add `watch` as a
  `subscribe(handler): Unsubscribe`-style stream contract + wire up `Platform.fs` + create a new fs
  service in agent-host (chokidar) + an RPC stream + web/mock implementations.
- **C-2. File tree** — lazy loading, a `.gitignore` filter (**decision on who implements this**:
  reuse the ignored list from `git status --porcelain` — avoiding both spawning a flood of
  check-ignore processes and reimplementing the syntax), the git status overlay as **M/A/U glyphs,
  not colour** (the achromatic rule — the spec's "colour indicator" wording gets updated in G),
  and a highlight for recently agent-modified files (the persisted touchedPaths from B-7).
  - Done: first render under 200ms on a 10k+ file repository (confirms only opened directories get read)
- **C-3. Code viewer** — CodeMirror, read-only (reuses B-2's lazy chunk) + Shiki.
  - **2 Shiki constraints to settle first**: ① the theme is a custom achromatic one (weight and
    lightness steps only) ② the default oniguruma engine is WASM, but Tauri's CSP has no
    `wasm-unsafe-eval` → **start with `createJavaScriptRegexEngine`**, and raise loosening the CSP
    as a separate decision if a performance problem is actually measured. Since this is the kind of
    thing that passes in dev (browser) but breaks under Tauri, **the done criteria explicitly
    require confirming highlight rendering inside the Tauri app**.
  - Done: in-file search, line numbers, line links, handling large (5MB) files, binaries and images, L5-2 baseline

## D. Attachments and pasting images (FR-13)

- **D-1. Composer attachments** — clipboard images, drag-and-drop, file picker, thumbnail preview.
  - **Decision on where they are stored**: images do not go into messages.payload as base64 (DB
    bloat + FTS pollution). They are stored as files under `~/.centralu/attachments/<sessionId>/`,
    with only the path in the payload. Cleaned up together when an archived session is deleted.
- **D-2. Adapter delivery** — files inside the project go as @-path mentions; external files and
  images go in the tool's own format. Reflected in the UI via the `attachments` capability.
  - Done: L3 S13 — attach 1 real image and confirm the agent reads its content (1× each for Claude and Codex)

## E. Search, palette and settings (FR-21, FR-17 complete, notification policy)

- **E-0. Schema migration runner (new — a prerequisite for E-1 and B-7)** — the store currently only
  runs `CREATE TABLE IF NOT EXISTS`, so **adding a column or FTS to an existing DB gets silently
  ignored**. `~/.centralu/store.db` already holds real-use data. Compare `user_version` → run
  migrations in sequence → backfill FTS.
  - Done: a test that opens a v1-schema DB file, migrates it, and confirms existing messages become searchable
- **E-1. Full-text conversation search** — FTS5 (availability was confirmed in the re-review — this
  is not a risk). **The real risk is Korean tokenization**: the default unicode61 loses recall once
  particles get attached.
  - Done: a test that **searches `승인` and matches a sentence containing `승인을`** (tokenize=trigram
    reviewed as the 1st option, index size recorded alongside), covering archived sessions, and
    jumping to the matched spot in the results
- **E-2. Command palette ⌘K** — unifies projects, sessions, actions and search results.
  - Done: L4 repeated operation — cycling through 10 sessions using only the palette (the m1.5 L4-3 pattern)
- **E-3. FR-17 complete = settings screen + the 5 unimplemented shortcuts** — v1 only wrote down the
  settings screen. Currently unimplemented: `⌘1~9` project jump · `j/k` session movement (outside
  the inbox) · `⌘K` · `⌘⇧1~4` tab switching (implemented in B-0) · `Enter/Esc` composer focus.
  Each is listed as its own done criterion, with change and conflict detection in the settings screen.
- **E-4. Approval rule management** — viewing and deleting them, plus **a match preview at
  registration time** (core's `previewMatches` already exists, but the UI does not use it — an
  unfinished part of the FR-3 promise).
  - Prerequisite: add `id` and `created_at` to the `approvals.rules` result + create a new
    `approvals.deleteRule` RPC (right now there is not even a key to delete by)
- **E-5. OS notification policy settings (a spec M2 item, missing from v1)** — `NotifyPolicy`
  already exists in core and only the default is used. Add 4 toggles in the settings screen
  (approval/error/all-done/foreground) + persistence.

## F. Release build wrap-up

- **F-1. Bring the F-0 result in for real** — the bundle script and CI, finishing a full session
  creation flow (S14) from a `.app` on a clean path, and reconfirming 0 zombies after SIGKILL. Code
  signing and notarization are **explicitly out of scope for dogfooding (my own machine)**.
- **F-2. Re-measure performance** — 4 projects + 4 sessions + the git and fs watchers running.
  Against the §7.1 bar, plus the watcher handle count.
- **F-3. Full regression** — all of L1 through L5, real-session smoke for both Claude and Codex.

## G. Doc alignment (new — before "code to throw away" grows any further)

Documents that went stale because of M1.5 decisions (keeping WS, deferring the git-to-Rust move) get
cleaned up together with this plan's own decisions:

- The "code to throw away" comment in `dev-services/git.ts` — corrected **before starting**, since B-1 grows this file 6×
- `docs/agent-host.md` §5 (the `--dev-services` flag does not exist; an error from describing the fs service ahead of building it)
- `docs/platform-abstraction.md` §5, the status of steps 4–6 (mark them as deferred)
- `docs/product-spec.md`: the FR-4 "Rust git2" implementation wording, FR-5 "M/A/U **colour**"
  (conflicts with the achromatic decision), the B-4 checkout behaviour, and the "bundled binary" comment in `sidecar.rs`
- Confirm in B-0 whether tab ends up in the `workspace` table's layout JSON, and document the schema

---

## Verification matrix (mechanizing the phase-end checklist)

A phase ends only once there are no empty cells. (L1 unit/contract / L2 E2E / L3 real session / L4 real-use reproduction / L5 visual)

| | L1 | L2 | L3 | L4 | L5 |
|---|---|---|---|---|---|
| F-0 | — | — | — | host ready in `.app` | — |
| A | contract (fixtures) | tool selection, concurrent sessions | S9, S10, S11 | zombie check (SIGKILL) | — |
| B | GitPort contract | diff, abnormal paths | S12 (updates mid agent-change) | watcher idle CPU, handles | tab shell, diff baseline + contrast |
| C | fs contract | tree, viewer | — | first render on a 10k repo | viewer baseline |
| D | — | attachment preview | S13 (reading an image, ×2 tools) | — | — |
| E | migration, Korean FTS | palette, rule management | — | palette repeated operation | settings screen baseline |
| F | — | — | S14 (full `.app` run) | 0 zombies from SIGKILL | — |

3 rules promoted from M1.5 are tied directly to tasks: the zombie check (A-2, F-1), the
reconnection path (also covering A-2's Codex process), and never ignoring warnings (every phase — verify includes 0 warnings).

## Known decisions (locked in for v2)

1. **Achromatic stays** — diff uses 2 steps of lightness + `+`/`-`, syntax uses an achromatic
   theme, git overlays use glyphs. Reasoning: the user's explicit decision ("black tones only").
   Revisit if a readability problem is demonstrated during dogfooding. The achromatic gate is
   strengthened to walk every CSS chunk.
2. **Push is included** — corrects what v1 dropped against the spec (§8 M2, FR-4). Limited to branches with an upstream.
3. **Deferring the git-to-Rust move stays deferred** — until measurement confirms a bottleneck. G brings the documents in line with reality regardless.
4. **CodeMirror is lazy-introduced in B-2, and the bundle-regression test is also in B-2** — deferring it to C would leave it unattended for the whole of B.
5. **Shiki starts with the JS regex engine** — wasm-unsafe-eval is not added to Tauri's CSP (avoiding a security trade-off).
6. **Distinguishing agent changes is file-level** — all files_touched gives is paths. Hunk-level is a non-goal.
7. **The bundling fallback is system Node** — since dogfooding is limited to my own machine, if SEA gets stuck, option ② carries M2 through.
8. **Checkout "shows the conflicts and asks whether to proceed"** — different from the spec's wording ("warn, then stop"); the spec gets updated in G.

## After M2

M2 done = **dogfooding can start through the `.app`**. Real-use period → complaint backlog → M2.5 improvements → M3.
The first thing to check during dogfooding: the one thing m1.5-result left unverified (whether the OS notification banner actually appears while away).
