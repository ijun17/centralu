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
| `?demo=grid` | The scene, opened in the grid with four panels — one of them working, so it wears the answering look. |
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

### The browser UI against the Centralu app already running

To work on the UI while looking at real sessions, run the browser UI against the host of the
app that is open on this machine, with one command and no host of your own:

```bash
pnpm dev:live             # http://127.0.0.1:5173/
PORT=5174 pnpm dev:live   # the other origin the host accepts
```

It reads the front door's port and a credential from the keeper (`<data folder>/keeper.sock`, op
`status`; the data folder is `CC_DATA_DIR`, or `~/.centralu`) and starts Vite for `apps/web`
with them set for that Vite only (`VITE_HOST_URL`, `VITE_HOST_TOKEN`). It reads the data
folder and never writes there, and it never prints the credential. Open the address it prints
with `127.0.0.1`, not `localhost`: the host accepts browser connections only from
`http://127.0.0.1:5173` and `:5174`, so the port is strict and a taken port is an error, not a
move to another one. The token stays the same across host swaps and updates and changes only when the app is
fully quit and opened again; run it again then.
It says in one line when no app is running, when the keeper has no host yet, and when the
port is taken. Windows has no keeper (the app runs the host directly there), so use the
shell recipe above.

The credential is the limited one (#1405): the page reads everything and does the everyday
things, but deleting for good, trusting, installing and answering the app's own cards are the
app window's. Such a click raises a card in the app's window, or is refused. A loopback port is
not per user: on a machine with other users, any of them can read the credential from the page
and every conversation with it, so use this on a single-user machine only. See
[security boundaries](docs/security-boundaries.md#local-transport).

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

CI runs in two tiers ([docs/releasing.md](docs/releasing.md#what-ci-does)). A pull request runs
the **quick tier**: `pnpm verify` on Linux and the unit tests on Windows. Everything else (the UI
scenarios in both engines, the bundles, the keeper, the host's tests on the remotes' Node) is the
**full tier**, which runs on main and on a release bump. A change lands after the **fast tier**
(#1259, the owner's decision of 2026-10-19): the merge queue (`queue_merge`) lands a pull request
through a batch built on main that runs the quick tier on what lands, a batch of one included; the
full tier then runs on main, after it landed. So nothing has run the UI scenarios, the bundles or the
keeper on your change before it is on main: run `pnpm verify` locally anyway, all of it, before you
push, and `pnpm e2e` for anything the UI shows. (`merge_when_green` still refuses a head whose own
run was quick.) Runs on main are never cancelled by a newer push, and the queue holds landing while
too many of them are unfinished. When main's full run fails, the board's main guard finds the commit
that broke it among those since main was last fully green (after rerunning once a job that failed in the runner's own setup, a browser install say, and
only if it fails again inside the test steps; an infrastructure failure is reported and never reverted), leaving out what it already reverted and
the reverts (the only one, or by running the full tier on candidates: a suspect by the failed job's
paths is confirmed that way too), reverts it in a pull request queued at the front of the merge queue
(never a release bump), files an issue with the failure and tells the session that queued it: fix it
on a new branch and queue it again. A release still needs a fully green commit of main. To run the
full tier on your branch before queueing it (UI work, a change to the keeper or the bundles):

```bash
gh workflow run build.yml --ref <your-branch>   # every job, on the branch's head; its checks show on the PR
```

**An auto-tier change lands without a pull request of yours** (#1259 step 3). When everything
your branch changes is auto ([below](#review-before-you-say-done): documents and images, fixture
data, UI icons and fonts, only the kinds the auto rules list), push the branch, made from main, and hand it over with the board's `integrate` (the branch,
the title, which becomes the squash subject, Why and Not exercised) instead of `open_pr` and
`queue_merge`. The integrator judges the tier itself, with main's `pnpm tier` and rules on GitHub's
copy of your branch, and refuses anything that is not auto, naming the files: then open a pull
request as usual. Auto, it opens the pull request itself as the record (labelled `tier:auto`, and a
draft until the queue squashes it, so nothing else can merge it: leave it a draft, even if an older
board's message says to mark it ready) and queues it for your session; it lands after the fast tier like any queued change, and the queue's
news (landed, a conflict, a failure, a later push that is no longer auto, a `tier:<name>` label above
auto) comes to your session. One branch per change: no stack. Push a fix to the same branch and call
`integrate` again; to land it as a pull request of its tier instead, `unqueue` it, mark it ready and
`queue_merge` it.

**A red run in the queue**: the queue reruns only what failed for the infrastructure's sake (a run
cancelled with no failed job, a job that hit its timeout, a lost runner, a job on the board app's
`queue.flakyJobs`). A test or build failure, also in a full run CI cancelled after `verify` failed
(fail fast), comes back to the queuing session at once, naming the job and its first failure line:
fix it and push; the queue takes the new head.

**A conflict with main in the queue** (#1182): the queue merges main into your branch itself. When
only files a command regenerates conflict (the lockfile, the schema doc, the migration goldens,
Tauri's generated permissions: `queue.conflicts` in the board app's `project.json`), it regenerates
them and pushes the merge, which runs CI again. Anything else, the UX baseline and store migration
steps always, comes back to the session that opened the pull request (`queue_merge` `author`) as
"merge main and push again; conflicted files: …". Merge main and push; the fixed pull request goes
to the front of the queue. A pull request stacked on one the queue just landed as a squash is
rebased onto main without that one's commits instead (`git rebase --onto`, pushed with
`--force-with-lease`); only when that rebase conflicts does it come back to you, saying how.

**A stack's lower pull requests are drafts** (#1066). The merge queue lands a stack through its top
(`queue_merge` with `lowers`), on the top's run and its batch, which test the whole stack; a lower's
own run only waits in line for runners. A draft runs no CI but the `changes` job. So open every
pull request of a stack but the top as a draft, bottom first as usual:

```bash
gh pr create --draft --base main --head part-1        # a lower
gh pr create --draft --base part-1 --head part-2      # a lower
gh pr create --base part-2 --head part-3              # the top: CI runs here
```

Stacking onto a pull request that is open and ready already, turn it into a draft
(`gh pr ready <n> --undo`); the board's `open_pr` does that by itself. When the top is closed and
a lower becomes the top, mark it ready (`gh pr ready <n>`): that starts its CI. The board's
`rebase_stack` says when the pull request it restacked is such a draft.

CI's full tier also runs the keeper's end-to-end scripts on macOS, the parts that need no model and
no network (`scripts/keeper-*integration.mjs`, the `keeper e2e` job;
[docs/agent-host.md](docs/agent-host.md) §4.1).

CI's full tier runs the whole Playwright suite **in both engines the desktop app is**: WebKit (WKWebView on
macOS, WebKitGTK on Linux) and Chromium (WebView2 on Windows), each split across parallel shards
(the `e2e (webkit i/n)` and `e2e (chromium i/n)` jobs). Locally `pnpm e2e` runs in Chromium, plus
the `-webkit.spec.ts` twins in WebKit; `E2E_BROWSER=webkit pnpm e2e` or `E2E_BROWSER=chromium pnpm
e2e` runs it the way one CI engine does. When a shard fails, the `e2e report` job uploads
one HTML report per engine (`e2e-report/<engine>/`), with traces of the failed tests (`pnpm exec playwright show-report
<folder>` after unzipping it). A twin repeats its base spec in WebKit and adds nothing, since CI
leaves it out (`tooling/e2e-webkit-twins.test.ts` checks this): a scenario that only means
something in WebKit goes in the shared fixture and skips itself in other engines.

Inside Codex's macOS seatbelt sandbox, run local `pnpm e2e`, `pnpm ux` and `pnpm perf` with
`E2E_BROWSER=chromium` only and leave WebKit to CI. Unset `STYLE_SNAPSHOT_BROWSER=webkit`
if present: that override selects WebKit even in a Chromium run. The perf specs respect
`E2E_BROWSER=chromium`; their default remains WebKit. macOS strips `DYLD_*` from sandboxed
launches, so Playwright's WebKit loads the
system framework and crashes with a dialog. The runner refuses WebKit and mixed runs before
launching a browser when `CODEX_SANDBOX=seatbelt` on macOS; the UX config checks at load time,
before starting its server. `CI=1` does not bypass either check. This repository's `AGENTS.md`
carries the local runner instructions; Centralu's child frame stays independent of the repository.

**A change to how a task is done is measured in operations.** `pnpm ux` runs the core tasks
(`e2e/ux/*.task.ts`) and prices each in keyboard and mouse operations with the Keystroke-Level
Model; CI's `ux tasks` job fails when a task goes over its budget. A new feature a person does
often gets a task, by the keyboard and by the mouse where both exist; a change that makes a task
cost more raises its budget in the same pull request and says why. How to write one and read the
numbers: [docs/ux-metrics.md](docs/ux-metrics.md).
The principles behind those numbers (judge the path a person can see, not its shortcut) and what
a pull request's **Usability** field holds: [docs/usability.md](docs/usability.md).

**The app's JS is compared with main's, and held under a ceiling** (#1181). `tooling/styles.test.ts`
builds the release bundle, and CI's `verify` job compares it with the size main's newest push run
recorded (or measures main when no run has a record): a change may add 30 KB without saying
anything, and the whole may not pass the ceiling in `tooling/bundle-budget.mjs`, however small
each step. Over either, find out what grew first; if the growth is meant, add a file of its own,
`tooling/bundle-growth/<your-branch>.json`, `{ "bytes": <n>, "reason": "<what grew and why>" }`, in
the same pull request (the test's message gives the number). It counts once against main, until
main's record lists it, and raises the ceiling for good. In CI a missing or unreadable record of
main fails the test with the reason; rerun once main's record exists. A local run checks the ceiling
only, and says it did not compare with main.

**Lint reads types, and what predates that only shrinks** (#1339). `pnpm lint` runs typescript-eslint's
type-aware rules on everything the root `tsconfig.json` compiles: no `any` flowing on from `JSON.parse`
or a catch, no assertion that narrows (`as T` from `unknown`, `x!`) in shipped code, no promise left
floating. Data from outside the process goes through a zod schema or a narrowing guard, and a caught
value's text through `errorMessage(e)` from `@cc/protocol`, not `(e as Error).message`. The findings that
were there when these rules came in are listed in `tooling/lint-allowlist/`, one list per package, a
sorted line per file and rule with the number of findings it may hold. A new finding fails, in a listed
file as anywhere else: fix it, do not list it. A file holding fewer than its line passes, and so does a
line for a file that is gone: a change that only fixes things need not touch a list, and two that fix one
finding each in the same file do not fail together. `pnpm lint:tighten` lowers such lines (run it when you
fix listed findings), and a weekly job (`.github/workflows/lint-tighten.yml`) opens a pull request with
whatever is left. A count moves only with a file git sees renamed: rename a file (with `git mv`, or `git add` the
move) and run `pnpm lint:tighten`, which moves its lines to the new path and says so. A file added at a path
main still has a stale line for holds nothing. Code moved into another file is a
new finding there, and a count freed in one file is not credit for another. `tooling/type-aware-lint.test.ts`
compares the lists with main's at the merge base (a push to main with its parent) and refuses any line that
is new or higher than main's but a renamed file's own (CI's `verify` fetches main's history for it and fails
without it; elsewhere, without one, the test says it did not compare).
The same test refuses an `eslint-disable` of a type-aware rule, a disable naming no rule, and a comment
that configures one off, and caps the type assertions (`as T`, safe ones too) in each package's shipped
code. `eslint` run by itself, and an editor, do not read the lists and show the old findings too. The
lint runs on two threads and without `--cache`: each thread builds the whole program (six took 13.6 GB),
and ESLint's cache keys a file on its own content while a type-aware finding can come from a type
another file changed.

**A new test must fail when the fix it guards is disabled.** Disable the fix, watch the test
fail, quote the failure in the commit or the PR, then restore it. A test that still passes
with the fix removed is not testing the fix.

**Code with a boundary gets a sweep, not one typical value.** Buffers, batches, caps, pages and
limits fail at sizes nobody picks by hand: the keeper's handoff failed on macOS only when about
8,000 bytes sat in the socket buffer before a descriptor batch, while 4,000 and 20,000 passed
(#387). Run the code across the boundary (every step from zero to a few times the limit, plus the
values right around it) and at the scale people actually reach (several agents, terminals and app
views, long sessions, a large store), not only the smallest state that exercises the path.

**A list that mounts and unmounts rows is tested by scrolling through it, and asserted on the
DOM.** The conversation showed one passage several times while storage held it once (#64): two
rows shared a React key, and each time the virtual list unmounted and remounted them while
scrolling, React left the old node behind. The probes at the time looked at one moment (a row was
missing, not repeated) and counted items in the store, so they never saw it. Drive the list from
end to end and back, then count what the DOM holds (`e2e/fixtures/conversation-copies.ts`).

The desktop app is WKWebView. If a UI bug does not reproduce in Chromium, try
`test.use({ browserName: 'webkit' })`.

**Where the keyboard goes is tested by typing the way a person does.** `locator.fill()` and
`locator.press()` focus their target before they type, so a test written with them cannot see
focus that went missing. That is how #115 (the composer silently stopped taking keys) passed every
suite: tests opened and closed the inbox, the palette and the settings screen and asserted on the
layer, never on what the next key did. For anything that opens, closes, hides or moves over
something, type with `page.keyboard`, pass through the path, type again, and assert on what the
person sees (`e2e/fixtures/composer-focus.ts`), in both engines. A new layer that takes focus
gives it back: it uses `Modal` or `useOpenLayer`, or `useFocusReturn` for a layer of its own.

**Two operations that write the same state are tested interleaved, not one after the other.**
Reading back through a conversation lost rows for good when a page of older messages landed after
a re-read had moved the cursor, and a re-read in the middle of reading threw away the pages already
read (#79). Every test ran each read alone, so the pair was never seen. Hold one answer back (a
gate in the mock, as the `#79` tests in `store-history.test.ts` do), run the other operation, then
release it, and assert that nothing is missing or repeated.

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
pnpm exec tsx scripts/keeper-content-integration.mts   # a keeper from verified content handing over
```

**Some defects only reproduce in the packaged app.** If you changed anything to do with
PATH, bundling or native modules, run `pnpm app` and check the real `.app` — dev mode
inherits PATH from your terminal, so it will never reproduce that class of bug.

## Before opening a pull request

**Run `pnpm pre-pr` first** (#1181). It checks what reviewers kept sending back that a machine can
see, on your branch's commits (not the working tree), each in a temporary worktree:

- `tsc` at every pull request head of a stack, oldest first: a lower pull request lands on its own,
  so it must build on its own;
- dependency-cruiser's orphans as errors (`pnpm verify` only warns);
- a store step number your branch adds (a new `to: N,` under `packages/agent-host/src/dev-services/store/migrations/`)
  that main already has or another open pull request adds (#1203): two parallel changes picking the
  same number each pass CI alone and clash when the second lands. It reads the open pull requests
  with `gh pr list` and `gh pr diff`, leaves out your stack's own, and names the one it clashes with.
  The numbers themselves come from the brief that gave you the work; a session whose brief names
  none and that finds it needs a step stops and asks (this check is only the backstop);
- a repository-wide guard test your branch adds or changes (any `tooling/*.test.ts`, a test that scans the
  whole repository from its root, or a file saying `pre-pr: guard`): each such guard is run against every
  other open, non-draft pull request's head merged with your branch, and the ones it would fail are listed
  with the first line of the failure. This never refuses: the list is printed and goes into **Verified**
  (as warnings), so you fix those pull requests in the same change or tell their authors. It is bounded:
  `--guards-limit <seconds>` (default 600), only the guards you changed, and a pull request that does not
  merge cleanly with your branch, or needs other dependencies, is skipped and named as not checked;
- each new or changed test file, run with every other change of the pull request reverted to its
  base: a new test that passes there protects nothing, and is reported;
- and, as a warning only (the merge queue merges main in anyway), whether the branch contains main,
  and what a merge would conflict on.

It also prints the change's **risk tier** ([below](#review-before-you-say-done)), and the board's
`open_pr` writes it into **Verified** as a `Tier:` line and labels the pull request `tier:<name>`.

`pnpm pre-pr --base <branch>` checks a pull request stacked on another branch; `--head <ref>`
checks a branch other than the one checked out. When one check's finding stands for a reason (a
test that cannot fail without the change, and why), leave that check out with the reason:
`--exempt revert="<why>"` (or `tsc`, `orphans`, `store-step`, `guards`). The board's `open_pr` runs it on the pushed branch
and refuses with what it finds; its `prePrExempt: { "revert": "<why>" }` leaves one check out, and
`skipPrePr: "<why>"` all of them. Either reason goes into **Verified**. Interrupted, it removes its
worktrees itself; killed outright, the next run does (or `pnpm pre-pr --cleanup <run-id>`). Do not
delete a `cc-pre-pr-*` folder by hand with a recursive delete: its worktrees hold links to your checkout's
`node_modules` (each workspace package's link points at the worktree's own copy, so `tsc` sees one
declaration of each class), and a recursive delete may follow them.

Then ask these against your change. Put anything you could not check in **Not exercised**.

- **What earlier state could still be there?** The keeper could still report a stale swap
  ([#621](https://github.com/ijun17/centralu/pull/621)).
- **What runs at the same time?** A parent's note raced with a child's turn
  ([#594](https://github.com/ijun17/centralu/pull/594)).
- **What does it do on Windows, and with the person's own config?** Worktree checks had to
  account for Windows short paths and git's `log.diffMerges`
  ([#620](https://github.com/ijun17/centralu/pull/620)).
- **What literal will go stale (versions, dates, ports)?** A hard-coded test version broke
  a release bump ([#625](https://github.com/ijun17/centralu/pull/625)).
- **Can it wait forever?** A script waited on workflows that might never run
  ([#622](https://github.com/ijun17/centralu/pull/622)).
- **Does the test fail for the right reason without the fix?** A helper-only test did not
  support that claim ([#619](https://github.com/ijun17/centralu/pull/619)); use the
  [test guidance above](#what-has-to-pass-before-you-send-it).

### Situations checked

Before opening a pull request that changes behaviour, attack it yourself: walk each situation
below and write what your change does in it, one line each, under **Situations checked** in the
pull request. Review rounds were the largest delay in landing work, and much of what reviewers
sent back was one of these (#1181). "Does not apply, because …" is an answer; a blank is not. A
change with no behaviour (documents, a pure refactor) writes n/a.

- **Host swap.** An older build is still serving the same store while the new one starts
  (`Store.migrate()`, [docs/agent-host.md](docs/agent-host.md)). What does each of them do with
  what the other wrote?
- **Link loss and reconnect.** The window, a remote or a child loses its connection in the middle
  of this and comes back. What is resent, what is lost, what is done twice?
- **An older build reading what this one writes.** A field, a message or a file this change adds,
  read by the build before it (a rollback, a remote not yet updated).
- **Two of the same thing at once.** Two sends, two deletes, two sessions, two windows doing this
  at the same moment ([the interleaving rule above](#what-has-to-pass-before-you-send-it)).
- **The person using the same session.** They type, approve, stop or switch while this runs.
- **Data loss.** What is deleted, what is kept, and what a crash halfway through leaves behind.

### Review before you say done

Every change has a risk tier by the paths it touches (#1259): `pnpm tier [--base origin/main]`
prints it and the files that put it there. The rules, one reason each, are in
[`.centralu/tiers.json`](.centralu/tiers.json); a change takes the highest tier of its files, and
a test (`x.test.ts`) takes the tier of the file it tests (`x.ts`). A symbolic link or a submodule is deep, and a file that is executable in the change at least light, whatever its name. No rules, rules that cannot be
read, or a skipped `pnpm pre-pr` make it deep.

| Tier | What falls in it | Review, inside the author's loop |
|---|---|---|
| auto | only harmless kinds, listed by extension: documents and images under `docs/**` (`.md`, `.txt`, images; not `security-boundaries.md`), fixture data (`.json`, `.txt`, `.sql`, `.csv`, `.yaml`, …), UI icons, images and fonts; any other file there (code, a script, a binary, a Makefile, anything unknown) is light | none beyond the checks; it lands without a pull request of yours, through the board's `integrate` ([how](#what-has-to-pass-before-you-send-it)) |
| light | everything no rule names, and anything in an auto folder of a kind its rule does not list: ordinary code and its tests, UI scenarios, CSS, copy inside `.tsx` | one review by another model in the author's session: a sub-agent reads the diff against the self-check above |
| deep | the store and migrations, `docs/security-boundaries.md`, trust and permission code and its tests, links, keeper and `centralu serve`, releases, `packages/protocol`, `tooling/**` guards, what CI runs the UI scenarios with, dependencies, `.github/**` and the board's merge gates | a separate review session that runs real-environment cases (packaged app, remote, Windows, a swap) |
| person | never by path: the label `tier:person`, set by hand for product direction or trust policy | the owner decides on the board |

The author runs that review before saying done and fixes what it finds; nobody relays review
rounds. **Verified** records who reviewed (which model or session) and what they found, fixed
or left. Raise a tier by hand when the paths understate the risk; never lower it.

## Commits and pull requests

- Commit messages follow [docs/commit-conventions.md](docs/commit-conventions.md):
  Conventional Commits, `<type>(<scope>): <description>`, with a body when the reason does not
  fit the subject.
- Pull requests use the template (Why / What changed / Verified / Situations checked / Usability /
  Not exercised / Closes).
  **Not exercised** names the surfaces you did not run: the packaged app, another platform, a
  live model session, a logged-out tool.
- **A move-only refactor lands when nothing is in its way.** A pull request that relocates or
  splits files (moving a module, splitting a test file) conflicts with every open pull request that
  touches those files, and each of them has to be redone by hand. Land it when the merge queue is
  empty, or after checking that no open pull request touches the files it moves:
  `gh pr list --state open --json number,files --jq '.[] | select(any(.files[]; .path == "<path>")) | .number'`
  for each moved path. Keep it move-only, so whoever does have to rebase over it can redo the
  move instead of reading a diff.

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
