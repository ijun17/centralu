# Contributing

Centralu is MIT ([LICENSE](LICENSE)). Issues and pull requests are both welcome.

## Open an issue first

For something small — a typo, an obvious bug — open the PR directly. For anything else,
**open an issue first.** A single screen in this app has several decisions tangled
together (the approval flow, session state, the notification policy), and discovering
after the code is written that it went the wrong way costs us both.

When reporting a bug, attach `~/.centralu/host.log`. The startup banner has the build
commit in it, so which build you were on is never in question.

There are templates for both kinds of issue — a bug, and a decision that needs settling
before code exists. Most issues here turn out to be the second kind. Neither has to fit:
the blank option stays open, because a half-formed observation is still worth writing down.

The pull request template has one field that is easy to skip and worth filling in anyway:
**Not exercised.** Say which surfaces your change touches that you did not actually run —
the packaged `.app`, another platform, a live model session. A reviewer reads that first,
because it is the only part of a PR that says where to go looking themselves.

## Getting it running

```bash
pnpm install

# browser dev — one shell so the per-launch token is shared without printing it
CC_HOST_TOKEN="$(openssl rand -hex 16)"
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

If you touched Rust:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

**Some defects only reproduce in the packaged app.** If you changed anything to do with
PATH, bundling or native modules, run `pnpm app` and check the real `.app` — dev mode
inherits PATH from your terminal, so it will never reproduce that class of bug.

## What is expected of code

- **Comments say why, not what.** Anything learned by measuring is kept together with
  the number that was measured.
- Tests are titled with the behaviour they describe. When one breaks, the title alone
  should tell you what fell over.
- New comments and documents are written in English
  ([#27](https://github.com/ijun17/centralu/issues/27)). Most of the existing ones are
  Korean; translating one is welcome as long as it keeps the reasoning intact rather
  than reducing it to a restatement of the code.

### Documentation

`docs/` is design documentation — [docs/README.md](docs/README.md) is the map.

- Change the design, fix the document **in the same PR as the code.** If the document
  and the code disagree, the document is the one that is wrong.
- Every "decision" table carries its reasoning. A decision with no reasoning behind it is
  a decision to revisit.
- Where a design document conflicts with the spec (`docs/product-spec.md`) on a
  requirement, the spec wins. On how something is built, the design document wins.

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
