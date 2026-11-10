# Working in this repository

For coding agents (Claude Code, Codex and others). Every session reads this file: it holds what
costs the most when missed, and says which document holds the rules for what you are about to change.

## Never

- Write to the real data folder (`~/.centralu`). Point `CC_DATA_DIR` at a temporary folder for
  anything that starts a host, also when you pass `--db`.
- Stop a process you did not start. No `pkill`/`killall` by name: the installed Centralu app,
  its keeper and its host match the same names, and your own session may be running under them.
- Trigger an OS permission prompt (screen capture, camera, protected folders) without asking.
  A tool started under Centralu asks in Centralu's name.
- Run two `pnpm e2e` (or `ux`, `perf`, `perf:memory`) at once on one machine, or start `playwright`
  yourself: the runners take the machine's lock. WSL and native Windows are two machines to it, so use one of them.
- Run `tauri build` / `pnpm app` unless asked: it rewrites the bundle a running app may be using.
- Merge your own pull request.

## Commands

| Need | Run |
|---|---|
| Everything that has to pass | `pnpm verify` (lint, dependency rules, types, tests); CI runs it too |
| Before a pull request | `pnpm pre-pr`, then `pnpm tier` for the review it needs |
| UI scenarios, all or one spec | `CI=1 pnpm e2e [filter]` (`E2E_BROWSER=webkit` or `=chromium`: one engine, as CI runs it) |
| Tests while other agents run tests | `pnpm exec vitest run --maxWorkers=4 <files>` |
| Rust shell and keeper | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` (run `pnpm bundle:host` first if `resources/host` is missing) |
| The UI without a host | `pnpm dev`, then `?mock=1` (empty) or `?demo` / `?demo=grid` (a seeded scene) |

Inside Codex's macOS sandbox, run local `pnpm e2e`, `pnpm ux` and `pnpm perf` with
`E2E_BROWSER=chromium` only; CI runs WebKit. Unset `STYLE_SNAPSHOT_BROWSER=webkit` too.
What reaches a running app without a restart: [CONTRIBUTING.md](CONTRIBUTING.md#how-a-change-reaches-the-running-app).

## Before you change …

Read the row's document first. The guard is what fails when the rule is broken; UNGUARDED means
nothing does, so your own check and the review must catch it.

| What you change | Read | The rule in one line | Guard |
|---|---|---|---|
| Anything | [CONTRIBUTING.md](CONTRIBUTING.md#what-is-expected-of-code) "What is expected of code" | Fix a hazard once, at its owner. One definition per concept. Root cause, not a stopgap. Less code, no dead code | pre-pr `orphans` (dead files only); the rest UNGUARDED |
| A concept, state or name | [domain-model.md](docs/domain-model.md) §1, §3 | One glossary. The UI never works out a session's state with conditions of its own | `guard/protocol-type-copies`, `core/session/state-parity.test.ts` |
| Which package code goes in, an import or a dependency | [architecture.md](docs/architecture.md) §2; [folder-structure.md](docs/folder-structure.md) §1–3; [platform-abstraction.md](docs/platform-abstraction.md) §4, §6; [tech-stack.md](docs/tech-stack.md) §6 | core and common do no IO; ui reaches the outside only through ports and never knows its OS; only apps pick an implementation. A library on the forbidden list needs reasoning in tech-stack.md | dependency-cruiser (pre-pr `deps`), `tooling/boundaries.test.ts`, `guard/ui-no-os`; a dependency is `pnpm tier` deep |
| Front-end state or settings | [state-management.md](docs/state-management.md) §3, §6 | Derived values (inbox order, counts, unread, badges) are selectors, never stored fields | UNGUARDED |
| A test | [CONTRIBUTING.md](CONTRIBUTING.md#what-has-to-pass-before-you-send-it) "What has to pass" | It fails with its fix disabled. Wait for events, not time. Sweep boundaries; interleave writers | pre-pr `revert`, `test-limits/scaled-by-slow` |
| A component or style | [design-system.md](docs/design-system.md) §1, §2, §4, §11, "Changing this" | Use the shared component (`Button`, `Segmented`, `Badge`, `Pill`, `TextInput`/`TextField`) and the scales. A new look is a token or component, with this doc changed in the same PR | `guard/hand-made-looks`, `guard/ui-radius-scale`, `guard/ui-type-scale`, `tooling/styles.test.ts` |
| Something that folds, appears, leaves or switches | [design-system.md](docs/design-system.md) §9 | Animated, about 150–200 ms, never blocking input; reduced motion leaves a short fade | UNGUARDED |
| A theme or ink | [themes.md](docs/themes.md) "The urgency order" | Contrast is urgency: `ink-signal` > `ink` > `ink-muted` > `ink-faint` on every surface | `packages/ui/src/app/theme.test.ts` (presets) |
| A string on screen | [ux-writing.md](docs/ux-writing.md) §1, §3 | English only, American spelling. Copy the nearest string that follows the rules; no internal words; one wording per state | `guard/archive-wording` ("trash" only) |
| How a task is done on screen | [usability.md](docs/usability.md) "Process"; [ux-metrics.md](docs/ux-metrics.md) "Budgets" | A frequent task has a ux task; a raised budget says why in the PR | CI `ux tasks` |
| What the product does | [product-spec.md](docs/product-spec.md) | The spec wins on what is built; the design document wins on how | UNGUARDED |
| Host code that touches the OS or processes | [architecture.md](docs/architecture.md) §2; [runtime-lessons.md](docs/runtime-lessons.md) (by rule id); [plans/os-layer.md](docs/plans/os-layer.md) | The OS only behind the OS layer; signal only pids you started; stdout carries the handshake only (HO1) | `local/os-imports`, `local/platform-checks`, `guard/git-start`, `log-file.test.ts` |
| Data from outside the process | [architecture.md](docs/architecture.md) §2 "Data from outside the process…" | Check it with zod or a narrowing guard, never `as T`; a caught value's text via `errorMessage(e)` | type-aware lint, `guard/type-assertions`, `tooling/type-aware-lint.test.ts` |
| An adapter | [agent-host.md](docs/agent-host.md) §3 step 3, §3.1 | Tests replay recordings of real runs. A new vendor name joins the drift contract. CLI names stay in `adapters/` | `agent/agent-adapter-checks`, `.github/workflows/drift.yml` |
| A protocol message | [protocol.md](docs/protocol.md) §4 | Additions only; a shape is declared once; an added host field has a default the client applies | `protocol.test.ts` (golden fixtures), `e2e/older-host.spec.ts`, `pnpm tier` (deep) |
| The store or anything stored | [agent-host.md](docs/agent-host.md) §5.1; [stored-shapes.md](docs/stored-shapes.md) "The rules" | Add first, remove later: a step never breaks the previous build. The step number comes from your brief, or ask | `store-migrations.test.ts`, `store-older-builds.test.ts`, `schema-doc.test.ts`, pre-pr `store-step` |
| An MCP tool definition or instructions | [agent-host.md](docs/agent-host.md) §1.1; [tool-cost.md](docs/tool-cost.md) §5 | Every word rides in every request. Raising a `*_BUDGET_CHARS` ceiling is a decision | `sessions/centralu-tools.test.ts`, `adapters/claude/tool-prefix.test.ts` |
| Trust, permissions, credentials, keeper, links | [security-boundaries.md](docs/security-boundaries.md), the section for the area | A session's credential is attribution, not proof, and never grants more than the limited credential's rights | `pnpm tier` (deep) |
| An app or its manifest | [apps.md](docs/apps.md) §1.1, §5 | Every app call goes through `ExternalApps.call`; a change of meaning goes through `manifestVersion` | UNGUARDED |
| CI or a release | [releasing.md](docs/releasing.md) "CI runner and action pins", "Releasing a version" | Explicit runner labels, actions pinned by SHA; a release needs a fully green main commit | `workflow-runners.test.ts`, `actions-pinned.test.ts`, `pnpm tier` (deep) |
| Code that cites a plan | [docs/plans/](docs/plans/) (`mailbox.md`, `remote-hub.md`, `thin-shell.md` most often) | A plan section the code cites binds it until that rule moves into a rule document | UNGUARDED |
| A document | [CONTRIBUTING.md](CONTRIBUTING.md#documentation) "Documentation"; [docs/README.md](docs/README.md) | In the same PR as the code. Decisions carry their reasoning | `schema-doc.test.ts` (generated schema only) |
| A commit or pull request | [commit-conventions.md](docs/commit-conventions.md); [CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pull-request) | Conventional Commits; `pnpm pre-pr`; the tier's review recorded in Verified | pre-pr, the board's `commit_check` |
| A report or a claim | [CONTRIBUTING.md](CONTRIBUTING.md#what-is-expected-of-code) | Say what each claim was checked against and what was not; keep the qualifiers when relaying | UNGUARDED |

## How work is done

Before opening a PR, run `pnpm pre-pr`, use the [self-check in CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pull-request) and write its [Situations checked](CONTRIBUTING.md#situations-checked).
Before saying done, get the review your change's tier asks for (`pnpm tier`; light: a sub-agent of
another model reads the diff against the self-check, deep: a separate review session with
real-environment cases) and record in Verified who reviewed and what they found
([how](CONTRIBUTING.md#review-before-you-say-done)).

With the project board app's tools, use them instead of `gh` by hand (`help` says which for what).
A change whose tier is auto (docs, fixture data, UI assets) needs no PR of yours: push its branch
and hand it over with `integrate`, which lands it. Owner answers (`list_owner_answers`): record each
on its issue in English with `comment`, then `mark_answer_recorded`. Never post the owner's text as written.

Talk to the person in whatever language they use. Everything written down (code, comments,
tests, documents, commits, issues, pull requests, reviews) is in English.
