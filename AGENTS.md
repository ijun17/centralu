# Working in this repository

For coding agents (Claude Code, Codex and others). Every session reads this file, so it holds
only what you cannot easily find out yourself and what costs the most when missed. The reasons
behind each line live in the linked documents.

## Never

- Write to the real data folder (`~/.centralu`). Point `CC_DATA_DIR` at a temporary folder for
  anything that starts a host, also when you pass `--db`.
- Stop a process you did not start. No `pkill`/`killall` by name: the installed Centralu app,
  its keeper and its host match the same names, and your own session may be running under them.
- Trigger an OS permission prompt (screen capture, camera, protected folders) without asking.
  A tool started under Centralu asks in Centralu's name.
- Run two `pnpm e2e` at once on one machine. Take the lock (below).
- Merge your own pull request.

## Commands

| Need | Run |
|---|---|
| Everything that has to pass | `pnpm verify` (lint, dependency rules, types, tests); CI runs it too |
| UI scenarios | `until mkdir /tmp/centralu-e2e.lock 2>/dev/null; do sleep 20; done; CI=1 pnpm e2e; rmdir /tmp/centralu-e2e.lock` |
| Tests while other agents run tests | `pnpm exec vitest run --maxWorkers=4 <files>` |
| Rust shell and keeper | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` (run `pnpm bundle:host` first if `resources/host` is missing) |
| The UI without a host | `pnpm dev`, then `?mock=1` (empty) or `?demo` / `?demo=grid` (a seeded scene) |

A change to `packages/agent-host` or `packages/protocol` only reaches a running app after a
restart; `packages/ui` and `packages/platform` reload live under `pnpm app:dev`. Do not run
`tauri build` / `pnpm app` unless asked: it rewrites the bundle a running app may be using.

## Map

- `packages/protocol`: types and messages shared by UI and host. Additions only.
- `packages/core`: pure domain logic. No IO, no React.
- `packages/platform`: ports (interfaces) and their web, Tauri and mock implementations.
- `packages/ui`: React. Talks to the outside only through ports.
- `packages/agent-host`: the Node host. Claude and Codex adapters, sessions, store, apps.
- `apps/desktop`: the Tauri shell (Rust) and the keeper that supervises the host.
- `apps/web`: the browser entry used by `pnpm dev` and e2e.

Vocabulary (session roles, apps, keeper, host, swap) and how the concepts relate: `docs/domain-model.md`.
The layer rules are enforced by lint (`docs/architecture.md` §2). Where things go:
`docs/folder-structure.md`. All design documents: `docs/README.md`.

## Traps

- The desktop app is WKWebView. A UI bug that Chromium does not show may still be real: try
  `test.use({ browserName: 'webkit' })`. Playwright's WebKit forces overlay scrollbars, so
  scrollbar bugs need the real app.
- PATH, bundling and native modules only misbehave in the packaged app; dev mode inherits PATH
  from your terminal.
- Store migrations add first and remove later: a step may not break the previous build, which
  can still be serving during a host swap (`Store.migrate()`, `docs/agent-host.md`).
- The host logs to stderr only. stdout carries one handshake line with a secret.
- Tests that wait on wall-clock time fail under load. Wait for an event, or give generous bounds.

## How work is done

[CONTRIBUTING.md](CONTRIBUTING.md) has the rest: tests that must fail without their fix,
commits ([docs/commit-conventions.md](docs/commit-conventions.md)), the pull request template
and its **Not exercised** field, and updating documents in the same pull request.

Talk to the person in whatever language they use. Everything written down (code, comments,
tests, documents, commits, issues, pull requests, reviews) is in English.
