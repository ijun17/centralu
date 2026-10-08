# Contributing

Centralu is MIT ([LICENSE](LICENSE)). Issues and pull requests are both welcome.

## Open an issue first

For something small — a typo, an obvious bug — open the PR directly. For anything else,
**open an issue first.** A single screen in this app has several decisions tangled
together (the approval flow, session state, the notification policy), and discovering
after the code is written that it went the wrong way costs us both.

When reporting a bug, attach `~/.centralu/host.log`. The startup banner has the build
commit in it, so which build you were on is never in question.

There are four issue templates: a bug, a design decision that needs settling before code
exists, an idea, and a UI/UX problem with something already on screen. Most issues here turn
out to be design decisions. Neither has to fit:
the blank option stays open, because a half-formed observation is still worth writing down.

The pull request template has one field that is easy to skip and worth filling in anyway:
**Not exercised.** Say which surfaces your change touches that you did not actually run —
the packaged `.app`, another platform, a live model session. A reviewer reads that first,
because it is the only part of a PR that says where to go looking themselves.

When you have pushed changes that answer a review, **leave a comment on the pull request
saying so.** Comments reach the maintainer straight away; new commits on their own do not
announce anything, and GitHub may not let you re-request a review from a fork.

## How issues and decisions are tracked

So you do not have to guess how this repository works:

- **Issues** live on this repository's GitHub Issues, in English, opened from one of the
  templates or blank. Open the issue first and wait for a direction before a large pull
  request; a small fix can go straight to a pull request.
- **Status** is tracked by the maintainer on a private GitHub Project (Status: Needs decision,
  Ready, In progress, In review, On hold, Done; plus Priority and Area). Contributors do not see
  it; anything that matters for you is said on the issue.
- **Labels** are applied by the maintainer (GitHub does not let contributors label). The ones
  in use:

  | Label | Means |
  |---|---|
  | `bug` | Something behaves differently than it should |
  | `enhancement` | Something new, or a change to how something works |
  | `ui` | About the screen and interaction |
  | `structural` | Needs a design change, not a local fix |
  | `needs-measurement` | Not a fact yet: has to be measured before deciding |
  | `first-run` | Blocks someone's first run |
  | `docs` / `documentation` | Documentation |
  | `accessibility` | A barrier for people with disabilities |
  | `good first issue`, `help wanted`, `question`, `duplicate`, `invalid`, `wontfix` | GitHub's usual meanings |

- **Decisions** are recorded where people will look for them: on the issue, as a comment that
  starts with **"Decision (owner, YYYY-MM-DD)"**, and, when the design moves, in the decision
  table of the design document it belongs to (see Documentation below). Larger designs get a
  plan in `docs/plans/` first. There is no separate decision-record folder.
- **Release readiness** is tracked on the 1.0 checklist (#364); known intermittent CI failures
  are collected on #368.

## Getting it running

```bash
pnpm install

# browser dev — one shell so the per-launch token is shared without printing it
CC_HOST_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')" || exit 1
[ -n "$CC_HOST_TOKEN" ] || exit 1
CC_HOST_TOKEN="$CC_HOST_TOKEN" pnpm host --port 5175 >/dev/null &
HOST_PID=$!
trap 'kill "$HOST_PID" 2>/dev/null || true' EXIT

VITE_HOST_TOKEN="$CC_HOST_TOKEN" pnpm dev   # http://127.0.0.1:5174
```

### Looking at the UI without a host

Two query strings, and `demo` implies `mock`:

| URL | What you get |
|---|---|
| `?mock=1` | The mock platform, **empty**. No projects, no sessions; nothing answers. This is the door E2E drives. |
| `?demo` | The same mock with a scene already in it: two projects, four sessions in different states (working, waiting on approval, asking a question, done), a conversation with tool cards and a plan, git changes and history, weekly usage. Send a message and a scripted reply streams back. |
| `?demo=grid` | The scene, opened in the grid with four panels — one of them working, so the orbit ring is turning. |
| `?demo=empty` | Replies, but no scene. For building a first-run screen without deleting a seeded one. |

The scene is re-seeded on every load, so an edit that reloads the page does not cost you
the setup. Ids are stable across reloads (`mock-session-1`, …), which is why the layout
you arrange by hand survives one.

Nothing in the scene is special-cased in the UI: it is built through the same ports the
app calls and the same events the host sends, so a screen that looks right here is not
being propped up by the demo.

The token comes from Node rather than `openssl` because Node is already required here and
`openssl` is not. The two `|| exit 1` guards matter more than they look: an empty
`CC_HOST_TOKEN` does not stop the host, it makes the host invent a random one, and the only
place that token is ever printed is the handshake the line above sends to `/dev/null`. The
result would be a host running on a secret nobody knows and a browser reporting "Host token
is required", which names the wrong cause. The guards stop the shell at the generator
instead. They are two lines rather than one because a failed command substitution and an
empty-but-successful one are different failures: `node` missing gives the first, a `node`
that prints nothing gives the second. A token that is only whitespace is refused by the
host itself, so that one does not need a guard here.

Do not use a fixed token such as `dev-token`, and do not paste real launch tokens into
issues, logs, screenshots, or test artifacts. The command above discards the host's
stdout handshake because it contains the token; diagnostic stderr stays visible. If you change the host port, pass the same
explicit URL to the UI with `VITE_HOST_URL=ws://127.0.0.1:<port>`.

For the real app rather than the browser:

```bash
pnpm app:dev      # ← the normal one. Save a UI file and it is on screen (HMR)
pnpm app          # build and open the release app (~60s incremental)
pnpm app:open     # open an already-built app
```

### How a change reaches the running app

Which of those you need depends on what you touched, and getting it wrong looks like
your change silently not working.

| Changed | Reaches the app by |
|---|---|
| `packages/ui`, `packages/platform` | saving, under `app:dev` (HMR) |
| `packages/agent-host`, `packages/protocol` | restarting the app — the host is not watched |
| `apps/desktop/src-tauri` (Rust) | recompiling, then restarting itself |
| anything touching PATH, the bundle, or native modules | `pnpm app` — those only reproduce in the packaged app |

## What has to pass before you send it

```bash
pnpm verify      # lint + dependency rules + types + unit/integration tests
pnpm e2e         # Playwright scenarios
```

CI runs `pnpm verify` on every pull request; run it locally anyway, all of it, before you push.
CI also runs the keeper's end-to-end scripts on macOS, the parts that need no model and no network
(`scripts/keeper-*integration.mjs`, the `keeper e2e` job; [docs/agent-host.md](docs/agent-host.md) §4.1).
Run `pnpm e2e` for anything the UI shows.

**A new test must fail when the fix it guards is disabled.** Disable the fix, watch the test
fail, quote the failure in the commit or the PR, then restore it. A test that still passes
with the fix removed is not testing the fix.

**Code with a boundary gets a sweep, not one typical value.** Buffers, batches, caps, pages and
limits fail at sizes nobody picks by hand: the keeper's handoff failed on macOS only when about
8,000 bytes sat in the socket buffer before a descriptor batch, while 4,000 and 20,000 passed
(#387). Run the code across the boundary (every step from zero to a few times the limit, plus the
values right around it) and at the scale people actually reach (several agents, terminals and app
views, long sessions, a large store), not only the smallest state that exercises the path.

The desktop app is WKWebView. If a UI bug does not reproduce in Chromium, try
`test.use({ browserName: 'webkit' })`.

If you touched Rust:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

The macOS shell that holds permissions (`apps/desktop/src-tauri/shell`, [plans/thin-shell.md](docs/plans/thin-shell.md))
is not a default member of that workspace, so the line above skips it. If you touched it, or the
verifier or the keeper start it uses:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -p centralu-shell
pnpm exec tsx scripts/shell-integration.mts   # the real binary against signed test content
```

**Some defects only reproduce in the packaged app.** If you changed anything to do with
PATH, bundling or native modules, run `pnpm app` and check the real `.app` — dev mode
inherits PATH from your terminal, so it will never reproduce that class of bug.

## Commits and pull requests

- Commit messages follow [docs/commit-conventions.md](docs/commit-conventions.md):
  Conventional Commits, `<type>(<scope>): <description>`, with a body when the reason does not
  fit the subject.
- Pull requests use the template (Why / What changed / Verified / Not exercised / Closes).
  **Not exercised** names the surfaces you did not run: the packaged app, another platform, a
  live model session, a logged-out tool.

## Running things safely

Development here starts real hosts, agents and apps on a machine where Centralu itself may be
running, possibly the very session doing the work.

- **Never touch real data.** Tests and scripts point `CC_DATA_DIR` at a temporary folder, never
  `~/.centralu`. When a host is started with `--db`, set `CC_DATA_DIR` too, or user-folder
  apps, attachments and worktrees still land in the real folder.
- **Never stop what you did not start.** Signal only process ids you started yourself. No
  `pkill`/`killall` by name: the installed app, its keeper and its host match the same names.
- **One `pnpm e2e` per machine at a time**; parallel runs share ports and fail each other.
  `until mkdir /tmp/centralu-e2e.lock 2>/dev/null; do sleep 20; done; CI=1 pnpm e2e; rmdir /tmp/centralu-e2e.lock`
- **Several agents on one machine:** limit test workers (`pnpm exec vitest run --maxWorkers=4`).
  Unlimited, each run takes every core, and timing-sensitive tests fail for load, not for bugs.
- **Ask before anything that raises an OS permission prompt** (screen capture, camera,
  protected folders). A tool started under Centralu asks in Centralu's name.

## What is expected of code

- **Comments say why, not what.** Anything learned by measuring is kept together with
  the number that was measured.
- Tests are titled with the behaviour they describe. When one breaks, the title alone
  should tell you what fell over.
- New comments and documents are written in English — see [Language](#language).

### Language

**English is the language of this repository**, for everything that is written down:

- code comments, test titles and documents
- commit messages
- issues, issue comments, pull requests and review comments

The project is open source, and a decision recorded in a language most readers cannot read
is a decision they cannot check. Most of the existing code comments and several older
documents are still Korean ([#27](https://github.com/ijun17/centralu/issues/27)).
Translating one is welcome as long as it keeps the reasoning intact rather than reducing it
to a restatement of the code. Quote non-English text verbatim when the exact words matter —
a user-facing string, an error message, a test title under discussion — and say what it
means next to it.

### Documentation

`docs/` is design documentation — [docs/README.md](docs/README.md) is the map.

- Change the design, fix the document **in the same PR as the code.** If the document
  and the code disagree, the document is the one that is wrong.
- Every "decision" table carries its reasoning. A decision with no reasoning behind it is
  a decision to revisit.
- Where a design document conflicts with the spec (`docs/product-spec.md`) on a
  requirement, the spec wins. On how something is built, the design document wins.
- **One glossary.** The project's vocabulary and how its concepts relate live in
  [docs/domain-model.md](docs/domain-model.md) and its Korean mirror `docs/domain-model.ko.md`.
  Do not add a second one (a `CONTEXT.md`, a glossary file, a folder of decision records):
  tools that expect one should be pointed at this file in your own local configuration.
  Decisions go in the decision tables of the design documents, with their reasoning.

## Contributor Licence Agreement (CLA)

**Sending a pull request is taken as agreement to what follows.**

For the contribution you send, you grant the project owner, and anyone who later
succeeds to the ownership of this project:

1. A **perpetual, worldwide, royalty-free, irrevocable, non-exclusive right** to use,
   reproduce, modify, distribute, **sublicense**, and make derivative works of that
   contribution, and to **transfer these rights** to a successor of the project
2. The right to **distribute that contribution under a different licence** (relicensing)
3. A patent licence to any relevant patents you hold

And you confirm that:

- The contribution is your own work, or you have the right to submit it this way
- No employment or other agreement prevents you from granting this

### Why this is asked for

Stated plainly: **to keep open the possibility of a paid licence for companies later.**

Once copyright in the contributions is spread across many people, changing the licence
means **getting every one of them to agree again.** A single contributor who cannot be
reached closes that road. So it is settled now, before contributions accumulate.

For individual users this means nothing. The code in this repository is MIT and stays
MIT. What could differ is the terms of **features added in the future**.

If you cannot agree to this, open an issue with the suggestion instead of a PR. Ideas do
not need a CLA.
