# M2 Result (2026-08-15)

> **Complete.** Dogfooding can now start through the `.app`.
> Plan: [m2-plan.md](m2-plan.md) (v2, revised after independent re-review) · Precedes from: [m1.5-result.md](m1.5-result.md)

## Results by phase

| | Content | Result |
|---|---|---|
| **F-0** | Sidecar bundling spike | ✅ [m2-f0-bundling.md](../spikes/m2-f0-bundling.md) — cleared 4 traps on day one |
| **A** | Codex adapter (FR-7 complete) | ✅ passed with a real session, [design-promise verification](../spikes/m2-a4-design-verdict.md) |
| **B** | Tab shell + git panel (FR-4) | ✅ confirmed against a real repository (loading 15 changes, diff, commit) |
| **C** | File tree + code viewer (FR-5, FR-6) | ✅ lazy loading, virtual scrolling |
| **D** | Attachments and images (FR-13) | ✅ paste, drag, file picker |
| **E** | Search, palette, settings (FR-21, FR-17, notifications) | ✅ includes the migration runner |
| **F** | Release build | ✅ `.app`/`.dmg`, 0 zombies, performance targets met |
| **G** | Doc alignment | ✅ corrected dev-services, the playbook, spec wording |

## Verification status

- Unit + contract: **231** (`pnpm verify`) · E2E: **42** (`pnpm e2e`)
- Real-session smoke: Claude (`pnpm smoke`) · **Codex (`pnpm smoke:codex`)** — S9 approval round trip, S10 remembers context after resume, S11 0 zombies
- Visual gates: achromatic palette (R=G=B) + required classes present + **bundle regression** (no CodeMirror or Shiki leaking in, 1.5MB JS ceiling)

## Performance measurement (F-2, on the release `.app`)

| Metric | Target (§7.1) | Measured |
|---|---|---|
| Idle CPU (2 projects + 3 sessions) | < 1% | **0.0%** |
| Memory (98MB app + 87MB host) | < 400MB | **185MB** |
| App bundle size | — | 10MB |

Idle CPU stays at 0 even with the git watcher attached — **there is still no case for moving to git2 (Rust)** (decision 3 stands).

## Defects that measurement caught (what the automated tests missed)

1. **Shift+digit makes `e.key` come out as `#`** → switched to judging by `e.code` (DigitN). `⌘⇧3` was not working at all.
2. **A selector building a new array every time caused an infinite re-render loop** (the second
   time in this project) → moved to a `useMemo` hook. The git tab was not rendering at all, but the
   E2E test only checked "did the tab state change," so it passed.
3. **The start prompt was not showing up in the conversation window** — a new path introduced along with the session-creation dialog.
4. **trigram FTS cannot find anything under 3 characters** — searching Korean '승인' and '배포'
   returned 0 hits. Anything under 3 characters now falls back to LIKE.
5. **The release app could not read git inside a protected folder (~/Desktop), but displayed "not a
   git repository."** Since what the person needs to do is the opposite in each case (grant
   permission vs. nothing at all), `denied` now gets its own distinct message.

## Decisions changed from the plan

| Plan | Actual | Reasoning |
|---|---|---|
| CodeMirror (merge view) + Shiki | **Neither is used** | An editor engine is overkill for read-only, and Shiki's default engine is WASM, which conflicts with Tauri's CSP. A bundle-regression test blocks them from creeping back in |
| Commit 642 generated bindings | **Only the 24 dependency contracts are committed** | With 0 imports and excluded from type-checking, it was dead weight that buried the review signal. `--check` catches anything that goes missing (confirmed by deliberately breaking it) |
| Node SEA as the first option | **System Node** | better-sqlite3 (a native addon) would require re-signing too — overkill for dogfooding |

## Known limitations (to confirm during dogfooding)

- **No code signing or notarization** — on first launch, it asks for protected-folder access, and
  refusing kills the git features. (It now at least says "permission needed," but the real fix is signing.)
- **Assumes Node is installed** — without it, all that shows is "could not start agent-host." The message needs to be more specific.
- **The OS notification banner while away** is still unverified (the one item left over from M1.5) — the first thing to check during dogfooding.
- Codex's `thread/name/updated` does not arrive for short sessions (not a problem, since FR-18 is satisfied by the first prompt).

## Next: dogfooding → M2.5

Run it on a real project for a few days and turn the complaints into a backlog. To run it:

```bash
open "apps/desktop/src-tauri/target/release/bundle/macos/Centralu.app"
# Or in dev mode: pnpm host & pnpm dev
```

## 1st round of dogfooding feedback (M2.5 kickoff, 2026-08-15)

| Report | Cause / fix |
|---|---|
| The start button did nothing | **Being a GUI app, the release build never gets the login shell's PATH**, so claude and codex were judged not installed → the tool buttons were disabled → so was the start button. Fixed by asking the login shell for PATH directly (not a fixed Homebrew list — nvm, mise and manual installs all get picked up too). The reason it cannot be used is now written on screen, so it no longer looks like it is simply not responding |
| Make model selection a dropdown, changeable after creation too | Added model/permission dropdowns to the session header. Takes effect from the next turn and persists across resume (store v4) |
| The creation modal only offered tool selection | Removed model and permission from the modal. Deciding them mid-conversation turned out more useful than fixing them beforehand |
| Render agent responses as markdown | react-markdown + gfm. Partially renders incomplete markdown during streaming too. Keeps the achromatic rule |

**Lesson**: the PATH problem can never reproduce in dev mode (the terminal already provides PATH).
This turned out to be one more defect specific to the release build, and it surfaced on the first day of dogfooding.

## Deferred (found during dogfooding, 2026-08-18)

### The search index grows to 37× the size of the conversation

Digging into a real-use DB of 128MB:

| | |
|---|---|
| Actual message payload | 3.3MB |
| `messages_fts_data` | 73.4MB |
| `messages_fts_content` | 46.5MB |

Choosing the trigram tokenizer was the right call — Korean attaches particles, so
`unicode61` cannot find "승인을" when searching for "승인" (this is documented in the v3
migration). The cost, though, is about 37× the original text.

`content` being 46MB means FTS is **keeping a separate copy of the original text**. That space
would not exist with `content=messages` (external content) — this is the first place to look.

This is not a breakage right now, but **growing at 37× the rate of the conversation** means it
reaches gigabytes within months. It matters more because the orchestrator's `recall` is planned to use this index.

### Measured again — the 37× was duplication, not the index design (2026-08-19)

The same DB after migration 11 ran (pinning the index to the message rowid, then VACUUM):

| | Before (128MB) | After (23MB) |
|---|---|---|
| Messages | 3.3MB | 10MB |
| `messages_fts_data` | 73.4MB | 5MB |
| `messages_fts_content` | 46.5MB | 4MB |

The index is not 37× the body text — it is **0.9×**. The cause was not the trigram tokenizer;
it was the same message getting into the index 8.6 times over, and that has already been fixed.

Moving to `content=messages` (external content) would remove the remaining 4MB in
`messages_fts_content`, but at the cost of having to keep the index in sync by hand on every body
update (a trigger, or delete+insert). **Saving 4MB out of 23MB is not a risk worth taking — this
does not happen.** Revisit if there is ever a reason to look at the growth rate again.
