# Contributing

Centralu is MIT ([LICENSE](LICENSE)). Issues and pull requests are both welcome.

## Open an issue first

For something small — a typo, an obvious bug — open the PR directly. For anything else,
**open an issue first.** A single screen in this app has several decisions tangled
together (the approval flow, session state, the notification policy), and discovering
after the code is written that it went the wrong way costs us both.

When reporting a bug, attach `~/.centralu/host.log`. The startup banner has the build
commit in it, so which build you were on is never in question.

## Getting it running

```bash
pnpm install

# terminal 1 — the agent host (Node sidecar)
pnpm host --port 5175 --token dev-token

# terminal 2 — the web UI. Development happens in a browser; releases go out as Tauri
pnpm dev                      # http://127.0.0.1:5174
```

`http://127.0.0.1:5174/?mock=1` runs the UI against a mock platform with no host at all,
which is what you want when you are only touching the interface.

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

For the contribution you send, you grant the project owner:

1. A **perpetual, worldwide, royalty-free, irrevocable, non-exclusive right** to use,
   reproduce, modify, distribute and make derivative works of that contribution
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
