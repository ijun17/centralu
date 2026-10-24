# Project board — a Centralu app

This folder is one app. Centralu runs `server.mjs` as an MCP server; people use it through its
screen (`ui/index.html`) and agents call the same tools as functions. Same tools, one code path.

## This app

The board is the GitHub Project named in `project.json` (owner, number, the repository a bare
issue number refers to, the three single-select field names, the decision status, the cache
length). Those are plain, non-secret values; change them there, not in code.

- **GitHub is the only copy.** `github.mjs` reaches GitHub only through the person's own `gh` CLI
  (`gh api graphql` for the board, `gh api repos/…`, `gh pr` and `gh issue` for CI, run with
  `execFile`, never a shell). An app server runs as the person, with
  their processes and network (docs/security-boundaries.md, "App servers"), so no Centralu
  capability is declared: `uses` and `secrets` stay empty, and no token is read, stored or
  printed. `gh` keeps its own login in the system keychain.
- **Cache:** one board in memory for `cacheSeconds`; a write forgets it, and a read that started
  before a write never refills it (`freshCache` in `cache.mjs`, which the reader's threads use too).
  Nothing about the board is written to disk.
- **Failures are stated, never an empty board.** `gh` missing, not logged in, missing the
  `project` scope, GitHub unreachable, or the project not found each become one plain sentence
  with the fix (`classify` in `github.mjs`). Agent tools answer them with `isError`; `show`
  answers them as data (`ok: false`) so the screen can say why there is no board.
- **Agents read short answers.** Claude Code hands the model a result's `structuredContent`, not
  its text (docs/apps.md §9.2), so the agent tools answer `{ summary, items }` (or `results` and
  `failed` for writes) as one line per item, `#113 Title — Status · Priority · Area`, and the text
  is the same lines. URLs, ids and whole item objects only with `detail: "full"`. `get_items` (or
  `list_items` with `numbers`) reads a few items in the order asked and names the ones not in the
  project.
- **Writes say what changed.** `set_item_fields` and `add_item` take one `item` or a list of
  `items` (each a reference or `{ item, status?, priority?, area? }`; top-level fields apply to
  entries without their own). Every reference and option name is checked before the first write,
  so one wrong name changes nothing. `set_item_fields` adds a visible issue or pull request if it
  is not on the project yet. Items run in order inside one `oneAtATime` call, one line each
  (`#297 Status Needs decision → Ready`); an item that fails is listed under `failed` and the
  batch carries on, unless the failure would repeat for every item (network, login, scope, write
  access), where it stops and names the items not tried. The batch is read back from GitHub once
  at the end, and a line says so when GitHub shows something else. `isError` only when nothing
  worked.
- Tests: `tooling/project-board-app.test.ts`, `tooling/project-board-ci.test.ts` and
  `tooling/project-board-reader.test.ts` run this server with a fake `gh` on PATH; the second also
  tests `ci.mjs` directly, the third `markdown.mjs` and the owner's saved answers (in a temporary
  data folder). `e2e/fixtures/board-reader.ts` drives the screen's reader and answer box in
  Chromium and WebKit.

## Reading and answering in the view

The owner reads an issue or pull request in the board instead of the browser, and answers a
"Needs decision" item from it. All of it is screen-only (`visibility: ['app']`), except the two
tools agents use to record the owner's answers.

- **The reader.** A card's title or number opens it in a modal dialog over the board (with ⌘ or
  Ctrl, on GitHub as before): kind, state, labels, Status/Priority/Area, the body, and the comments
  oldest first with the newest last, "Open on GitHub" beside them. A `#123` inside opens that item in
  the same reader. Esc closes it and the keyboard goes back to the card it came from, found again by
  its item if the board re-rendered meanwhile. `read_item` answers it.
- **Threads** are read by `readThread` (github.mjs) in one GraphQL query per page of 100 comments,
  newest page first, up to 1,000 (`THREAD_MAX_COMMENTS`): a longer thread keeps its latest 1,000 and
  says how many there are. The view gets the latest 50 and a "Show earlier" button. Cached like the
  board: in memory for `cacheSeconds`, at most 40 threads; a posted comment forgets its thread, and
  a read that started before the post never refills the cache.
- **Markdown** is rendered on the server by `markdown.mjs` (GitHub's flavour: tables, task lists,
  code, images, `#123`, `@name`; a newline is a line break, as in comments). It is safe by
  construction: every character is escaped text or inside a tag the renderer writes itself from the
  list in `ALLOWED`, with attributes built from checked values; raw HTML is text, except a few tags
  GitHub allows, written anew. Links go only to http, https and mailto. The view puts the HTML in
  through an inert `<template>` and removes anything outside the same list before it reaches the
  page, because the view's CSP allows inline script (docs/apps.md §6.4).
- **Images** load only from GitHub (`github.com`, `*.githubusercontent.com`): the view's resource
  declares those two as `resourceDomains` in `_meta.ui.csp` on its contents (`viewResource` in
  view-tools.mjs; the runtime's `uiResource` puts nothing there), and markdown.mjs turns an image on any
  other host into a link. An image GitHub will not hand the view (a private repository's upload)
  becomes a link too.
- **"Needs decision"** (the header's second button) lists the items with that Status, each with the
  Question and Recommendation of its latest `## Decision needed (summary, …)` comment, and
  "Answered" when a `Decision (owner, …)` comment came after it (`decisionSummary` in markdown.mjs,
  `decision_summaries` in decision-tools.mjs).
- **The owner's answer never goes to GitHub as written** (owner decision, 2026-10-12: the
  repository is public, and the owner answers in their own words and language). The answer box
  under an item whose Status is the decision status saves it with `save_answer` ("Save answer" or
  ⌘/Ctrl+Enter) in this app's data folder, `owner-answers.json` through
  `centralu.readJson`/`writeJson`: the per-user app data Centralu gives the app, outside the
  repository (`answers.mjs` holds the rules, pure). The screen then says plainly that nothing was
  posted and that the agent records the decision in English, and shows the answer on the item
  ("saved …, not recorded yet") with Edit and Delete (`delete_answer`) until it is recorded. Edit
  opens it in the box; Esc steps back out of the change. Saving again replaces the answer waiting;
  a recorded answer is history and shows with its decision comment ("recorded in English"). A
  failed save says why and keeps the text. Drafts live in the screen's memory only. Both tools are
  screen-only; nothing on the screen posts to GitHub.
- **Agents record it** (both model-only): `list_owner_answers` (`all?`; read-only) lists the
  answers not recorded yet with the item's title and the owner's text, which agents never post as
  written. The agent posts the decision on the issue in English with `comment`, in CONTRIBUTING.md's
  form `**Decision (owner, YYYY-MM-DD):** …`, then calls `mark_answer_recorded` (`item`, `url`) with
  that comment's address. It reads the comment back from GitHub and refuses unless it is on that
  item, holds "Decision (owner, YYYY-MM-DD)" and is in English. `list_needs_decision` marks an item
  with an answer waiting "· answered, not recorded yet" (and counts them in its summary), the
  screen's "Needs decision" cards say "Answered, not recorded yet", and `read_item` and
  `decision_summaries` carry `ownerAnswer`.
- **Input methods.** An Enter or Esc the input method took (ending or cancelling a Korean syllable)
  neither reviews, steps back nor closes: `composing` in the screen, the same three signs as
  Centralu's `composingKey` (docs/usability.md).

## CI and merging (#386)

The repository's contribution procedure, kept as code so every agent follows it the same way. The
decisions are pure functions in `ci.mjs`; `github.mjs` reads GitHub; `ci-tools.mjs` puts them together.
`project.json` `ci` names the workflows that hold the required checks, the issue listing known
intermittent failures (#368), and how long a merge may wait.

- **Green means every required check is reported and passed.** No checks reported, a required check
  not reported yet, or one still running is not green (on 2026-10-05 a script read "no checks yet"
  as green and merged #380 before CI started). Skipped and neutral count as passed, as on GitHub.
- **The required set** comes from branch protection and rulesets on the base branch when there are
  any, else from the jobs of the `ci.workflows` files read from the base branch (so a PR cannot make
  its own checks optional), with `${{ matrix.x }}` names filled in. A job whose check name cannot be
  worked out makes every reported check count. With no set at all, every reported check counts.
  This repository's build.yml leaves jobs out of a pull request by its files (`changes`); a left-out
  job reports `skipped` or a stand-in under the same name, and a set written into branch protection
  must name `changes` too (docs/releasing.md, "What CI does").
- **`ci_status`** (`pr`, or `ref` and optional `repo`; read-only): short by default: the verdict,
  `passed/total`, and only failed or pending checks. `detail: "full"` also lists passed and
  non-required checks. Compact output still says when the PR adds required jobs (#445).
  `read_failed_job` reads at most 40 lines around a job failure, without timestamps or colour codes.
- **`merge_when_green`** (`pr`, `body?`, `wait?`, `waitMinutes?`, `deleteBranch?`): refuses unless the
  gh account has maintain or admin permission (checked first), the PR is open and not a draft, the
  checks are green and GitHub can merge it. Squash only, with `--match-head-commit`, never `--auto`
  and never `--delete-branch` (that flag deletes the local branch and, when a Centralu worktree
  has it checked out, removes that worktree and its session's folder, #715; the branch is deleted
  through the API when asked, on GitHub only, never a fork's, never a local branch). Session
  deletion removes a worktree and its branch, not the merge. Subject `Title (#N)`; body from `body`
  or the description's Why / What changed / Closes, without `Co-Authored-By:` or "Generated with" lines; no author flag,
  so the PR author stays the author. Pending answers at once unless `wait: true`, which polls every
  `pollSeconds` up to `waitMinutes`, sends a progress notification each poll (Centralu ends a call
  after 10 minutes without one), and stops if the PR's head moves. A Codex session gets an early
  "still running" at 240 s and follows the call with `run_status`.
- **`mark_ready`** (`pr`, `note?`, `detail?`): the end of a contributor's flow (#386 merge policy:
  merging is the maintainer's act, and `merge_when_green`/`queue_merge` refuse without maintain or
  admin). Marks a draft ready for review (`gh pr ready`) unless a required check failed, which it
  names as `ci_status` does; pending checks do not stop it, and the answer says CI goes on. `note`
  becomes a comment for the maintainer under the public text rules (checked before anything is
  written), ending with the CI line. No permission check: anyone who may push to the pull request
  may mark it ready.
- **Never call `merge_when_green` or `mark_ready` against a real PR in a test**; the tests use a fake `gh`.

### Waiting without blocking

Start `node .centralu/apps/project-board/bin/wait-checks.mjs <pr>` in the background instead of
holding an MCP call open (or give `owner/repo#pr` or its URL: the forms the tools take, `parseItemRef`). Use `--ref <branch|sha>` instead to wait for
a branch or commit in the configured repository; the ref is resolved once and its pinned SHA is printed with the label.
It allows two minutes for workflow registration and waits for active workflows before deciding
on checks. `--timeout-minutes <minutes>` sets the overall deadline (default 90 minutes), including
polling, retries, and hung `gh` subprocesses. Failed `gh` calls retry three times, after 1/2/4 seconds.
Exit codes: 0 passed, 1 failed, 2 argument/GitHub error, 3 approval/action required, 4 no workflows
or checks after the grace period, 5 cancelled (supersession named only when confirmed by a newer
run on the same workflow/branch/event/repository), 6 timed out. `waiting`/`action_required` stop
with an action-needed message. The policy is in `wait-checks.mjs`, tested with a simulated clock
in `tooling/project-board-wait-policy.test.ts`; the executable CLI and fake `gh` are tested in
`tooling/project-board-wait-checks.test.ts`. `PROJECT_BOARD_WAIT_POLL_MS` changes the 30-second
poll only for tests.

## The merge queue (#956)

Many pull requests, or a stack, landed without anyone holding a call open. A detached shell loop did
this before and could only write a log line when a pull request went DIRTY; nothing moved for three
and a half hours. The decisions are pure functions in `queue.mjs`; `queue-driver.mjs` keeps the queue
file and polls; `queue-tools.mjs` has the tools; `bin/merge-queue.mjs` is the watch command.

- **Risk tiers (#1259 step 2), not read by the queue yet.** `open_pr` writes pre-pr's tier into Verified
  and labels the pull request `tier:auto|light|deep|person` (a person may raise it by hand). The label is
  what the paths said when it opened, so commits pushed later leave it stale. A `skipPrePr` (a fork's pull
  request) or a pre-pr that answers no tier labels `tier:deep`. The hook for the queue: the tier of what it
  is about to land is the higher of `tierOfChange` (`scripts/tier.mjs`) at that head over main and
  `tierOfLabels` of its labels; no label, rules missing or unreadable, or any failure, is deep.

- **`queue_merge`** (`pr`, `lowers?`, `owner?`, `author?`, `deleteBranch?`; model only): one pull request, or a
  stack as `pr` (its top) and `lowers` (the ones under it), which land as one squash through the top
  after its base is moved to the default branch; the lowers are then closed with "Landed in #N".
  Refuses at once, as `merge_when_green` does, without maintain or admin, for a draft or a closed pull
  request, and for a top based on a branch none of its lowers has. A pull request is in one item only.
  `owner` names the queuing session (default a new id); the answer gives the watch command. `author`
  names the PR's author session, the one that opened or owns it and that a conflict is handed to
  (#1182): default the caller's own, which is the `owner` it gives (an app server cannot tell which
  session called it, docs/apps.md §5.1), else the one recorded before, else none (a generated owner
  id is no session); `merge_queue` lists it on each item. Queued
  again (what an attention message may ask for), an item is looked at afresh: its clocks and failure
  count start over, a merge GitHub refused is tried again, reruns spent on its head stay spent, and
  without a new `owner` it stays the first session's, whose watch command listens for that owner (and
  without a new `author`, the first author's).
- **`merge_queue`** (`all?`; read-only, agents and the screen) and **`unqueue`** (`pr`; changes nothing
  on GitHub).
- **Each poll** reads one item (`decideBefore`, `decideCi`): no maintain or admin, a draft, DIRTY
  (which the queue first tries to resolve itself, below), BEHIND, BLOCKED, a squash subject over 72 characters, or a base that is not the default branch or a
  lower's branch → attention. Only the CI workflows' own checks count (`readWorkflowChecks`, their
  check suites: a release job of the same name is not CI, #624), and the run to rerun is the PR's own
  pull_request run when a push run shares the commit (`latestRuns`). **Only an infrastructure failure
  is rerun** (below, "Reruns"): a cancelled run once per head and failed jobs once per head (`gh api
  …/rerun`, `…/rerun-failed-jobs`), written down before asking and counted as done only once its
  attempt number moves; a test or build failure, GitHub refusing the rerun, failing again or cancelled
  again → attention, naming the job and its first failing line. No run on a head
  for 15 minutes, or a required check never reported for 20 minutes while nothing else runs (a renamed
  job, a path-filtered workflow) → attention. A head that moved starts over (reruns, required set,
  clocks, attention). Green and **CLEAN only** (an unattended queue is strict: UNSTABLE, HAS_HOOKS and
  UNKNOWN wait, and after 30 minutes → attention; one exception, #1015: UNSTABLE when every check on
  the head passed or belongs to a run of a CI workflow that a successful run on the same head made
  moot, cancelled or older, and every commit status succeeded, as a cancelled duplicate pull_request
  run left #971 UNSTABLE for good; `onlySupersededFailures`. Also a duplicate run whose every failed
  job succeeded in a twin, another completed run of that workflow on the head, whatever their ids,
  times or attempts (a skipped job is no twin; #1346: the newer of two same-second runs failed a job on
  a flake that the other passed on a rerun; `twinPassedSuites`, read by a batch's landing too). Landed as usual, nothing rerun: a rerun
  of the duplicate would spend a whole CI run to change nothing) → every open lower must be inside the top's head
  (compare: the green run, read on that head, ran on all of them) and no lower's own latest CI run on
  its head may have failed at or after the run that proved the top was created, its own or its batch's
  (`lowerFailureCounts`, → attention `lower-failed`). A later failure is evidence the top's run
  missed (#1072 under #1075: a runner-dependent Windows bug); an earlier one is outlived by the top's
  run on a newer main (#1039 under #1040: a test main had since fixed). Then squash with `--match-head-commit` on the head read, subject `Title (#N)` without
  attribution lines (`squashMessage`, as `merge_when_green`). Only GitHub's word that it merged counts:
  `gh pr merge` can exit 0 under GitHub's own merge queue without merging (→ attention, not asked again
  on that head). A stack lands only when the top merged into the default branch, here or found merged
  (a driver stopped between the merge and writing it down, or by hand): then each head branch is
  deleted and the lowers closed, a branch kept when another open pull request is based on it (deleting
  it would close that one). Found merged into another branch, nothing is closed or deleted. Never
  `--auto`, never `--delete-branch`, never a force push but one: the lease after a restack (Conflicts, below).
- **Failures on one item** that are not an outage (a pull request gone, a write GitHub refuses) are
  counted; three in a row → attention, once.
- **Gentle on GitHub**: one item per tick (5 s), each item again after its own wait (90 s while CI
  runs, 2 min while it needs attention), the required set read once per head, the permission once per
  10 minutes. A rate limit (`rate`, now in `FATAL`), no network or no login pauses the whole queue,
  from 1 minute doubling to 15, shown in `merge_queue`.
- **Where it lives**: `merge-queue.json` in the app's data folder, read and written whole and
  synchronously for each change, so it survives the server restarting. A file that does not read
  stops the driver, said once in the app's log, then tried again with a growing wait. Centralu stops an app with no
  open screen and no call after 5 minutes unless it says it is busy (docs/apps.md §4): the manifest declares
  `uses.background`, and this server holds busy exactly while the queue has an item waiting or in CI, or a batch
  with its end to do (not one needing attention: it waits on a session, and one forgotten would keep the app polling
  for good) (`queueBusy`, after every tick and every change a tool makes; the row reads "Running: merge queue, N
  items"), so the queue carries on overnight with nothing open (#1236). The queue has two drivers: this server, and
  the **watch command** a session runs in the background. One drives at a time through `merge-queue.lease.json` (renewed
  every tick and before every write, free after 3 minutes of silence or as soon as its process is gone,
  let go on exit).
- **Telling the session**: every change worth a message is an event with a sequence number and the
  item's owner. Attention is one event per change (`noticeKey`: the reason, the head and the job), not
  one per poll; a merge or a close is one too. The manifest declares `uses.notices`, so `queue_merge`
  keeps the calling session's notice address on the item (`centralu.noticeAddress()`, docs/apps.md
  §10), each message event carries it (`to`), and this server posts it into that session after every
  tick (`tellSessions`, #1161 item 1): it arrives as a report does, with the relay text in an
  attention message, and the event is marked `told` (or `failed` after 6 tries 30 s apart: the
  session is gone, or the Centralu cannot post). `merge_queue` never shows the address. An item
  queued from an older Centralu has no address, and the watch command still works for every item:
  `node .centralu/apps/project-board/bin/merge-queue.mjs
  watch --data <folder> --owner <name> --after <seq>` (queue_merge answers it whole) drives the queue
  while it waits and exits with that owner's messages: 3 when one needs attention, 0 for a merge or
  when nothing is left, 6 at its deadline (`--minutes`, default 100), 2 for a wrong argument or an
  unreadable queue, 130 or 143 when stopped by SIGINT or SIGTERM (the tick in flight finishes and is
  written down first). It names the command to run again, quoted like queue_merge's (`shellQuote`). A Claude session is woken when a background command ends.
- **Until acknowledged** (#1351, a stopgap until the mailbox, #1347; all of it in `notice-acks.mjs`, so the
  mail can replace that one module): a message that needs attention stays unacknowledged for its owner
  until the owner calls `ack` (`owner`, not blank, and `seqs` or `upTo`), so a session that missed it (a
  `watch` restarted with a later `--after`, a crash, a notice lost in a compacted or busy session) finds
  it again. `merge_queue` with `owner` lists that owner's unacknowledged messages first, with what to
  do; without `owner` it only counts them by owner. `watch` with no `--after` starts from the owner's
  oldest unacknowledged one, and never repeats one acknowledged; the posted notice and `watch` add "Ack
  it with … ack({ owner, seqs })". One still unacknowledged 30 minutes after it was posted there
  (`toldAt`) is posted once more (`repostedAt`); a repost Centralu does not take is tried again as a
  first post is, then given up on (`reposted: 'failed'`). The other messages (landed, closed, a batch's
  end, main red) are for information: once posted into the session they count as acknowledged, so they
  are never listed; one never posted (no address, an older Centralu) is still news to a `watch`. Kept on
  the event (`ackedAt`), in the queue file. A message with no owner is not kept. A queue file from
  before this counts what it already said as acknowledged (`acksFrom`), so an upgrade replays nothing.
  The file keeps the last 200 events, so on a very busy queue an old message can still go.
- **The screen** shows a "Merge queue" section above the board while it has items, or messages not
  acknowledged (one line naming whose): needs attention (with why), CI, waiting, merged in the last
  day, each with Unqueue while active. Nothing tells a
  screen when the driver moves an item, so it reads `merge_queue` again every 15 s while one is active.
- `PROJECT_BOARD_QUEUE_TICK_MS`, `PROJECT_BOARD_QUEUE_POLL_MS`, `PROJECT_BOARD_QUEUE_TELL_RETRY_MS` and `PROJECT_BOARD_QUEUE_REPOST_MS` shorten the waits only for tests.
  Tests: `tooling/project-board-queue.test.ts` (the decisions, the app against a fake `gh` that
  records every write, a restart, the watch command), and the screen in `e2e/fixtures/board-reader.ts`.

### Reruns (2026-10-19)

On the queue's first day 19 runs were rerun, most of them a test failing the same way again, each a CI
run the next batch waited behind. The owner's rule: **the queue reruns only infrastructure failures**.
`run-failure.mjs` holds it (pure); the driver reads, for each finished run that did not pass, its jobs
and their steps (`runJobSteps`, `/actions/runs/{id}/jobs`) and what GitHub wrote on each job that did
not pass (`checkRunNotes`, `/check-runs/{id}/annotations`), once per run attempt (kept on the item or
the batch as `failures`), and `decideRun` decides from it, for an item's head and a batch's alike.

- **Real** (no rerun, attention at once): a job that failed in a step (a test, a build), or failed
  with nothing naming the runner; also when the run's conclusion is `cancelled` because CI cancelled
  the rest after it. The attention text names the job, the step, and (as before) its first failure
  line from the job's log; for a cancelled run it says CI cancelled the rest (fail fast).
- **Infrastructure** (rerun once per head): a run or job cancelled with no failed job; a job that hit
  its timeout (conclusion `timed_out`, or GitHub's "has exceeded the maximum execution time of N
  minutes" / "The action '…' has timed out after N minutes"; a test's own "timed out in 5000ms" is a
  test failure); a lost runner ("lost communication with the server", "received a shutdown signal");
  a job whose first failed step set it up (cause `setup`, #1435: checkout, pnpm and Node setup, the
  browser and system-library installs, a cache; the main guard reads main's runs the same way, below);
  a failed job on `project.json` `queue.flakyJobs` (exact names, `*` for any characters). A real
  failure beside any of these makes the run real.
- **The contract with CI** (two sessions built the two sides at once): in a full-tier run, when the
  `verify` job fails, CI cancels the rest of that run at once (fail fast). The queue therefore never
  reads a run's conclusion alone: a `cancelled` run with a failed job is a failure.
- A batch reads its run the same way: a real failure is split at once (no rerun first), an
  infrastructure one rerun once.
- Without a reading of the run's jobs for its attempt (`decideRun` called without `failures`), the
  checks decide: a cancelled run with a job that failed is real, one without is cancelled (rerun), any
  other failure is real.
- `PROJECT_BOARD_QUEUE_FLAKY` (the list as JSON) sets the list for tests only. Tests:
  `tooling/project-board-queue.test.ts` (the classification, the decision, and the app against the
  fake `gh`: a verify failure not rerun, in a failed and in a fail-fast cancelled run; a timeout rerun
  once; a lost runner rerun and landed).

### Conflicts (#1182)

A conflict stopped the item before; a person or the queuing session merged main by hand, and the item
then waited behind everything queued since (#1091 conflicted three times). `queue-conflict.mjs` does
the git work; `onConflict` in `queue-driver.mjs` decides, once per head.

- **The merge**: a DIRTY (or CONFLICTING) pull request based on the default branch, from a branch of
  this repository, gets the default branch merged into it in a temporary worktree of the checkout
  this app is committed in (`queue.conflicts.checkout` to change it), as `rebase_stack` works: the
  refs fetched under `refs/centralu-queue` for a moment, hooks off, the person's checkout and branches
  never touched, the worktree removed whatever happens. What a run killed half way leaves (its
  folder, named `centralu-queue-merge-<pid>-…` in the temporary folder, its worktree registration,
  fetched refs) is swept at the start of the next run (`sweep`: folders of processes that have
  ended). A remote branch not at the head GitHub reported is read again on the next poll, and
  nothing is merged into it. A fork's branch, or a stack's top based on a lower's branch, is handed
  off at once (the reason says why). GitHub saying DIRTY of a branch that has the default branch in
  it already ("Already up to date" here) is handed off too: there is nothing to push, and waiting for
  a new head would wait for ever.
- **The lint allowlists** (#1423): `tooling/lint-allowlist/*.txt` are mechanical files too. Two pull
  requests that each lower counts in the same list conflict once the first lands. The queue takes
  main's version, runs `pnpm lint:tighten` (which lowers every line to what the merged tree holds),
  then the allowlist check (`tooling/type-aware-lint.test.ts`: lists sorted, and no line new or higher
  than main's), and pushes only if both pass. The check runs while the merge is not committed yet;
  `baseCommit` (`tooling/lint-allowlist.ts`) then takes the newer merge base of the branch tip and of
  `MERGE_HEAD` with `CC_LINT_BASE`, which the queue sets to the main tip it just fetched, so the
  comparison is with main's lists as the merge commit will have them, as in CI, not with the branch's old
  fork point. A finding the merged tree has beyond the lists, or a failing check, fails the command, and
  the conflict goes to the author as any other. `lint:tighten` lowers every list the merged tree no longer
  needs, so the merge commit may carry a lowering in a list that did not conflict; the commit message, the
  `regenerate` event (`also`) and its `stat` list those files too. A conflict in a list and in code goes
  to the author without running anything.
- **Mechanical files**: when every conflicted file is named by an entry of `project.json`
  `queue.conflicts.mechanical` (`files`: path patterns as `release.versionFiles`; `run`: commands as
  argument lists, run in order without a shell, each at most `timeoutMinutes`, default 30; on Windows
  a `.cmd` shim such as pnpm is started through cmd.exe), the default branch's version of each is
  taken, each command of the matching entries runs once in list order (the lockfile entry first, so
  the installs after it find it current), only the conflicted files and the files the entries name
  are staged, and a file still holding a conflict marker stops it. The merge is committed ("Merge main
  into <branch>", the person's own git identity) and pushed **never forced**: a fast-forward of the
  head that was read, which git refuses when the branch moved. Refused because the author pushed while
  the queue worked, it ends quietly (`superseded`, no hand-off): the author's head is the news, and
  the next poll takes it. The pushed commit is a new head, so CI runs on it again (and through a
  batch, the full tier) before it lands: nothing lands that CI has not passed on. A merge git makes
  cleanly though GitHub said DIRTY is pushed the same way. Tests fail if the push gains `--force` or
  the check that the branch is at the head GitHub reported goes.
- **Stacked on one the queue landed as a squash** (#1221 on #1218, 2026-10-19): GitHub moves such a
  pull request's base to the default branch, but its branch still carries the lower's original commits,
  which conflict with their own squash (five files there), and merging main in cannot fix that. So
  before merging, the queue looks for a pull request it landed (its merged items' heads, newest first)
  whose head is in the branch and not in the default branch (squashed, not merged), the nearest one
  (`landedUnder`), and rebases the branch onto the default branch without its commits (`git rebase
  --onto <default> <its head>`, hooks off, in the same temporary worktree). Pushed with a lease on the
  head it read (`--force-with-lease=refs/heads/<branch>:<head>`, the owner's, 2026-10-19: the only push
  the queue forces), so git refuses it when the author pushed meanwhile (`superseded`, as for a merge).
  The new head runs CI (and a batch, the full tier) before it lands, and goes to the front once fixed.
  Only a rebase that itself conflicts is handed off, with that instruction ("Rebase <branch> onto main
  without #N's commits (git rebase --onto origin/main <head>) … push with --force-with-lease"), not
  "merge main". Events: `rebase` (`dropped`: that pull request, `files` when it conflicted), then `push`
  with `lease: true`.
- **What regenerating made is shown**: a regenerated golden is approved without a person, and would
  be the baseline from then on even if it records a regression. So the commit body and the
  `regenerate` event carry each regenerated file's lines added and removed against the default
  branch's version (`stat`), for a person to look at.
- **The risk: code of the pull request runs on the queue's computer.** The commands run in a worktree
  of the pull request's branch merged with main: `pnpm docs:schema`, `vitest`, `bundle:host` and
  `build.rs` under `cargo check` are its code, from anyone who may push a branch to this repository
  (a fork's never runs). They run as the person who runs the queue, unattended. Limits: every `pnpm
  install` has `--ignore-scripts` (no lifecycle script of the pull request's packages runs), and each
  command gets an allow-listed environment (`commandEnv`: PATH, home, temporary and system folders,
  locale, the cargo, rustup and pnpm homes, `CI=1`), so no GH_TOKEN, GITHUB_TOKEN, API key or any
  variable Centralu gives its apps reaches it. HOME stays (pnpm's store and cargo need it), so files
  the person's account can read (`~/.npmrc`, `~/.cargo/credentials`, a gh login stored in a file
  rather than the keychain) and the network remain within reach. The owner accepted that
  (2026-10-18): a pull request from a branch of this repository already runs its code in CI with the
  same trust, and the queue never runs a fork's (`cannotMergeBase`).
- **node_modules without an install**: when the merged tree's `pnpm-lock.yaml` is the default
  branch's and the one the queue's checkout installed (`node_modules/.modules.yaml` there), the
  checkout's node_modules are linked into the worktree (`mirrorModules`: each workspace package's
  node_modules a real folder of links, a link to a workspace package pointing at that package in the
  worktree, so the merged source is what runs) and no `pnpm install` of the list runs, so native
  modules built for the checkout are there. When the lockfile differs, the list's installs run with
  `--ignore-scripts`; a native module may then be missing (better-sqlite3, which the schema doc and
  the migration goldens need), its command fails, and the conflict goes to the author session: the
  safe way to fail. No rebuild runs (it would run a dependency's install script). **The links are
  removed before anything is removed recursively** (`dropLinks`: unlinked, never followed; also in
  the sweep of a killed run's folder): `git worktree remove` follows a junction on Windows, and
  would delete the checkout's own node_modules. Tests: both paths, and both removals with a link
  left in place.
- **The lists** (the owner's, 2026-10-18): `pnpm-lock.yaml` (`pnpm install --lockfile-only --ignore-scripts`; pnpm runs
  the version `package.json` `packageManager` pins), `docs/generated/schema.md` (`pnpm docs:schema`),
  the store migration goldens (`vitest run --update` of `store-migrations.test.ts`), and Tauri's
  `permissions/autogenerated/*.toml` (written by `build.rs`: `pnpm bundle:host`, then `cargo check`).
  `queue.conflicts.never` is never regenerated, whatever the mechanical list says, and always goes to
  the author session: `e2e/ux/baseline.json`, and store migration steps and their numbers
  (`store/migrations/*.ts`, `migrate-runner.ts`). Tests check that every pattern names a tracked file
  and every script exists.
- **The hand-off** (any other conflict, a command that failed, a push refused): attention `conflict`,
  with the files and `relay` (`to`: the item's author session, `branch`, `text`: "Merge main into
  <branch> and push again; conflicted files: …"). Until an app can message a session (#1173) the
  attention event names the author session and carries that instruction for the queuing session to
  relay; with no author recorded it says so, and that a session started on the branch needs that
  instruction. Once per head; queued again, the merge is tried again (main may have moved).
- **The front of the queue**: a pull request fixed after a conflict (a new head that no longer
  conflicts, the queue's push or a session's, or queued again after one) gets `front`, and goes
  first: batches take it before older items, and `merge_queue` lists it first in its state
  (`queueOrder`), instead of behind everything queued while it was fixed.
- **Events with durations**: every step is an event of kind `conflict` (not a session's news) with
  `step` and `ms`: `merge` (the files), `regenerate` (the commands, `stat`), `push` (`by: 'queue'`),
  `superseded` (the author's head, `tip`), `handoff` (`by: 'session'`, `relay`), and `fixed` once a new head no longer conflicts (`ms` since the conflict
  was found, `by` the queue or a session's push), so the daily metrics can count conflicts handled
  without a person.
- `PROJECT_BOARD_QUEUE_CHECKOUT` (empty: none) and `PROJECT_BOARD_QUEUE_CONFLICTS` (the lists as JSON)
  change these only for tests, which otherwise would merge in this checkout, whose remote is GitHub.
  Tests: `tooling/project-board-queue.test.ts` (the lists, and the app with real git and a bare
  repository standing for GitHub's: a pull request stacked on a squashed one rebased and landed, or
  handed off when even the rebase conflicts; mechanical only lands with no attention, code, the UX baseline and
  a migration step hand off; a branch that moved, an author pushing during regeneration, a branch with
  main in it already, a failing command; the environment the commands see, and the cleanup on each
  path).

### Batches (#962)

The free plan runs about one CI build at a time, so pull requests queued together each waited for
their own run in one line. `batch.mjs` holds the rules (pure), `queue-batch.mjs` does them on GitHub,
and the tick drives the running batch before any item, under the same lease. On while `project.json`
has `queue.batch` (`min` items to start one, at least 2, or 1 with two tiers of CI below; `max`,
default 4: the owner's, 2026-10-19, this repository's too).

- **Which**: active items in CI whose own CI was read on their head, not sent back from a batch on
  that head (`batchless`), not a fork's (its head would run CI in this repository's branch) and not a
  release bump (its CI is the release's evidence), in one repository, those fixed after a conflict
  first (`front`), then in the order they were queued; a stack is one item, so one member. With two
  tiers, **every ready item** (2026-10-19): its own quick run passed, still runs, waits for a runner
  or has not reported yet, but not one whose own CI failed (its poll handles that). Without tiers,
  only one whose own run has not started (every run `queued`, `waiting`, `requested` or `pending`):
  that run could land it, and cancelling a started one throws work away. Day one, taking only those
  not started or finished, made batches of 1.25 pull requests on average, about 20 minutes each, one
  after another (5 queued: about 100 minutes). Sent back, an item is batchable again only after its
  own next poll. One batch runs at a time; an item in a batch is not polled on its own (`dueItem`).
- **Gathering**: a batch that is not full waits while another active item of its repository, queued
  less than a minute ago, has not been read on its head yet (`gathering`), so pull requests queued
  together in a row share one batch instead of the first going alone.
- **Building**: each member is read again (still open, not a draft, not DIRTY, the same head). A
  branch `queue/batch-<n>` is made at the default branch (never moved: one that exists ends the
  batch), and each head is merged into it in order on GitHub (`POST /merges`); one that conflicts
  goes on with its own CI and is not batched again on that head; so does one GitHub will not merge
  into it for another reason (a 404 or 422, a head gone, already in main). With two or more merged, the CI
  workflows are started on the branch (`workflow_dispatch`); GitHub refusing that (no trigger, no
  permission) ends the batch and makes none for an hour (`batchOff`), before anything is cancelled.
  Then the members' own runs that have not started are cancelled (with two tiers, every one not
  finished: the batch's full run tests what a quick run does, and the runners are the batch's), each
  written down before it is cancelled (`cancelled`, which a batch split or re-formed from this one
  keeps for its members).
- **CI on the batch** is read as an item's head is (`decideRun`, shared with `decideCi`): the
  required set from the default branch plus jobs the batch adds, and only an infrastructure failure
  rerun, once (Reruns, above). A member that changes meanwhile (pushed, closed, a draft, taken out,
  queued again) ends the run; the rest are tried again without it. **Red** (a test or build failure,
  or an infrastructure failure twice): split in halves, a half of
  two or more tried again, one alone goes back to its own CI; with two tiers every half is tried
  again, down to single pull requests (bisect, below). Anything else (no run in 15 minutes, a
  refused rerun) sends them all back.
- **The required-checks rule** (#962's open question, decided here): the queue's own rule, with no
  branch protection change. A member's required checks count as passed when the batch run passed
  every required check (the same workflow file and job names, read the same way) on a commit whose
  tree is what the default branch becomes when it lands. GitHub is not asked to take a status in
  place of a check: the repository has no protection rule, and if one is added that requires checks
  on the head, GitHub answers BLOCKED and the member goes back to its own CI. Requiring only a batch
  status in branch protection was the other option; it was not taken: it changes the repository's
  settings, and every merge would then need a batch's status, which `merge_when_green` and a pull
  request queued alone never get.
- **Landing**: one member per tick, in order, as its own squash (`land`, `afterMerge`: the same
  checks, subject, lowers and branches as alone), each only while the default branch's tree is the
  tree the batch had before it; the last one leaves exactly the tree CI tested, and the batch's end
  says whether it did. A member's own runs were cancelled, so GitHub may call it UNSTABLE: that alone
  does not stop it when every check that did not pass is a run the batch cancelled, or a run a
  successful run of the same workflow superseded (a duplicate started in the same second, an older
  run: `supersededSuites`, as on the single path, #1015), or a mix of both (`onlyCancelledByBatch`;
  queue/batch-89 sat in landing for a same-second duplicate and looped back); anything else waits 30
  minutes, then the rest go back. Before each merge
  a `merge-queue` success status on its head names the batch run. The default branch moved by
  something else, a head moved, a draft, DIRTY, BEHIND, BLOCKED, a long subject: that member and the
  rest go back to their own CI (where the usual attention says what is wrong). Found merged with the
  batch's tree after it (a driver stopped before writing it down), it counts as landed. The batch
  branch is deleted when the batch ends, whatever the end, but only once the queue has written down
  that it made it (`branchMade`), and only while it is still the driver.
- A member sent back has its own run cancelled: the item's poll reruns it (a cancelled run once per
  head), which is what tells the session what is wrong with it, if anything.
- The watch command does not say "Nothing left queued" while a batch with the owner's pull requests
  still has its end to do (`watchState`); it waits for it, and its notice.
- `merge_queue` lists running batches first, `batch` on each member, and `batches`; the screen tags a
  member "batch N". Batch events are for the screen, not a session; a member's merge is its owner's
  news as ever ("Tested in batch …"). `PROJECT_BOARD_QUEUE_BATCH_MIN` changes `min` only for tests.
  Tests: `tooling/project-board-queue.test.ts` (the rules, and the app against the fake `gh`: green,
  red and split, the default branch moved, dispatch refused, a conflict).

### Two tiers of CI (2026-10-18)

GitHub Actions was the bottleneck: a full run of `build.yml` is about 24 jobs, the free plan runs 20
at once, and every push of every pull request started one. The owner chose two tiers: a pull
request's own run is the **quick tier** (`changes`, `verify`, the Windows unit tests); the **full
tier** (every job) runs on main, on a manual run (a batch's dispatch, or a person's) and on a release
bump's pull request (`.github/scripts/ci-changes.mjs`). A skipped job counts as passed, so a quick run
alone is green on what it reports. On while `project.json` has `ci.fullTier`, the name of the check
that passes on a full run only (build.yml's `full tier` job; `ranTier` reads it: `full` when it
passed, `quick` when it finished otherwise, null while not reported).

**What lands on what (`ci.landTier`, #1259).** With `full` (the default, and this repository's until
2026-10-19), nothing lands that has not passed the full tier on what lands. With `quick` (this
repository's since the owner's decision of 2026-10-19), a change lands after the **fast tier**: its
own quick run, then its batch's run of the quick tier on what lands (the batch's dispatch asks for
`tier: quick`; `ci-changes.mjs` answers the full tier anyway for a release bump or a commit on main).
No e2e, Windows end to end or keeper before the merge: the full tier runs on main after it lands. The
rules below are `full`'s where they say "full tier"; with `quick`, a batch lands from its green quick
run and the full tier's check is not asked for. That run is judged as a pull request's own quick run is
(`quickGreen`): every run finished, nothing it reported failed or is pending, the full tier's check
skipped; and more strictly, since it decides a landing (`quickLanded`), every run concluded well and
**each check named in `ci.quickChecks`** (this repository's: `changes`, `verify`, `windows tests (vitest
*)`; `*` for any run of characters) was reported and succeeded, every check its name matches: a quick
check never reported (a renamed job, one a broken `changes` switched off, a shard GitHub never created)
or skipped does not land, it is left to `decideRun` (missing-check). The list is checked at start: with
`landTier` "quick" and no names, the app does not start (an error, not "anything goes"). The required set is the whole workflow's, whose full-tier jobs a quick run never reports (a
matrix job left out reports no check of its name at all), so those are not missing: without this the
green batch queue/batch-98 stopped with "never reported" (2026-10-19). The main guard does not read
the required set: it judges main's runs and its probes by their conclusion, and both are full runs.

- **An item lands from a full run**: its own head's (`decideCi` merges only when `ranTier` is `full`:
  a release bump, or a full run a person started on its branch), or a batch's. A head whose own run
  finished, ran less than the full tier and passed what it ran (`quickGreen`) waits for a batch
  (`ci.verdict` `quick`); one the queue cannot batch (a fork's, a release bump's quick run, batches
  off) → attention `full-tier`, saying how to start the full tier on it.
- **Every item lands through a batch** then, **a batch of one included**: `min` may be 1 (this
  repository's), and the fewest left after a split, a conflict or a change is 1, whatever `min`. A batch also takes
  items whose quick tier passed, oldest first; one sent back from a batch on its head (`batchless`)
  is taken alone, when it is the oldest. The batch's run must have passed the full tier's check too,
  or nothing lands from it (the batch is dropped).
- **Bisect** (2026-10-19): a red batch is split in halves, each a batch of its own built in turn on
  the default branch as it is then, so a half that passes lands before the other half is tried, and a
  red half is split again. **A pull request red alone** (the end of a bisect, or a batch of one) needs
  attention at once (`failed`: "#N failed alone in batch …", the job, its step and its first failure
  line), kept as `alone.reason` on that head, which its poll answers before anything else
  (`decideCi`): its own run, cancelled for the batch, is not rerun first only to say "quick tier
  passed", and the message is sent once.
- **A batch of one that ended without landing its member** otherwise (refused, stopped, three errors,
  a conflict alone) marks it `alone` with why: not batched again on that head, and its next poll tells
  its session (`full-tier`, with the batch's reason). A new head, or queueing it again, clears it.
  Without this a red batch of one was formed again every tick.
- **`merge_when_green`** refuses a head whose own run was the quick tier (`quick-tier`, saying to use
  `queue_merge` or to start the full tier), and waits while the full tier's check has not passed.
- **The release** takes a bump PR's run as evidence only when the full tier's check passed on it,
  when the required set names it (`ciForRelease` `tier`): a quick run skipped what main's runs test.
- `PROJECT_BOARD_CI_FULL_TIER` sets the check's name for tests only (empty: no tiers, as a repository
  without them), and `PROJECT_BOARD_CI_LAND_TIER` the landing tier; the queue's app tests run each way. Tests: `tooling/project-board-queue.test.ts`,
  `tooling/project-board-ci.test.ts`, `tooling/build-workflow.test.ts`.

### The main guard (#1259)

With changes landing after the fast tier, the full tier runs on main after they land. The **main
guard** (`main-guard.mjs`, its actions in `main-revert.mjs`) watches it: on while `ci.landTier` is
`quick` (unless `queue.guard.enabled` is false), one step at most every 2 minutes once the queue has landed something, in the same ticks as
the queue and by whichever driver holds the lease. Its state is the queue file's `guard`: `green` (the
last fully green commit of main), `pending` (main's newest push run still going), `hunt` (a red being
looked into).

- **Main's state** (`mainVerdict`): build.yml's push runs on the default branch, newest first. A run
  on main is never cancelled by a newer push (build.yml's concurrency: `cancel-in-progress` is false
  for `refs/heads/main`, #1259 review), so every landed commit's full run finishes and is seen. One
  still running (or cancelled by hand) says nothing; the newest that passed is `green`; the newest
  that failed, when newer than it, is the red to look into; `unfinished` counts those still going.
- **Holding landing**: while more than `queue.guard.maxMainRuns` (3) of main's full runs are
  unfinished, the queue lands nothing and moves nothing (`tick` answers `held`; `merge_queue` says
  "Landing held: N of main's full runs unfinished"): each landing adds a full run, and the runners
  are shared.
- **Infrastructure before blame** (#1435, 2026-10-21): a browser install got a 403 from a package source,
  and the queue opened a revert of reviewed work. The guard reads the failed run's jobs and steps as the
  queue reads a pull request's run (`diagnose`, `classifyRun`), before it looks for a culprit. A run
  whose failed jobs all failed in a step that sets the job up (the cause `setup`: "Set up job", checkout,
  pnpm and Node setup, rust toolchain and cache, artifact download, the browser and system-library
  installs; `pnpm install` only when its log names the network or a package source), hit their timeout or
  lost their runner is **infrastructure**: the guard reruns the failed jobs once and does nothing else.
  Reruns are kept **per run id** (`guard.reruns`, written down before it asks, the newest 30): while a
  rerun is going, `mainVerdict` shows the older red run, and a single slot had two overlapping reds rerun
  each other for ever. A rerun that passes leaves no trace. One that fails inside the test steps is a
  **test** failure and goes on as below. One that fails in setup again is the runner's unless a commit
  since the last green one changed what the setup reads (`queue.guard.setupInputs`, path patterns:
  `.github/**/*`, the lockfile, every `package.json`, the Rust toolchain pin and `Cargo.lock` by default;
  the browser's version comes from the lockfile and the system libraries from build.yml, and none of that
  runs on a pull request, only in main's full tier) and no line of the failing step names the network or a
  package source (`looksLikeNetworkError`: a status only as a status, "403 Forbidden" or "HTTP 502", never inside a
  version; a timeout, "could not connect", "Hash Sum mismatch", "is not signed", "Download failure"; not a bare
  apt "Failed to fetch", which a 404 prints too; real outages print warnings before the error line; an outage that outlasts the
  rerun would otherwise blame whatever touched a lockfile): then it is a **setup failure** and is hunted
  like a test failure (a probe without the bad commit passes setup). Otherwise it is reported (an issue and a
  notice, "an infrastructure failure, not a commit's", naming how many commits it checked), never
  reverted, as is a lost runner again. A timeout, or a job on the flaky list, that fails again is looked
  into as a test failure, except a timeout in a step that sets the job up (#1503: the step the limit ended is the one GitHub
  marks 'cancelled', or 'failure' for a step's own `timeout-minutes`; "Install WebKit" and the like): nothing of the commit
  ran, so it is read as a setup failure is: reported unless a commit since the last green one changed what the setup installs
  (`queue.guard.setupInputs`), and only then hunted. Its annotation counts only when it names the step that ended the job: a
  first try with `continue-on-error` that ran out of time leaves one on a job whose tests then really fail. A job cancelled at its time limit carries GitHub's word only in its
  annotation, so the guard reads the annotations of cancelled jobs too, when no job of the run failed. A rerun GitHub refuses, or has not started in 10 minutes, is reported the same
  way. Any real failure in the run makes it a test failure.
  The notice, the issue ("Kind of failure: **infrastructure failure**", "**setup failure, after a rerun**" or "**test failure**") and the revert
  pull request say which. The line quoted is the first error line of the step that failed first
  (`firstStepError`, ci.mjs): from its `##[group]Run` line to its `##[error]` line, so the report or
  artifact upload that runs after a failure ("No files were found with the provided path") is never the
  quote. The pull request's own runs use the same classifier: a setup failure is rerun once.
  A bisect probe that fails in setup is still read as red (#1453).
- **The candidates** are the first-parent commits after the last green one up to the red one, with
  their subjects and files, read from the checkout (`QUEUE.conflicts.checkout`, fetched into
  `refs/centralu-guard`; the checkout's branches and work are not touched). No green commit known, or
  no checkout: the guard reports the red without a culprit.
- **The culprit**, in order: the only candidate; else a **suspect by the failed jobs' paths**
  (`queue.guard.jobPaths`: a job's name, or the start of a matrix job's, → path prefixes or exact
  paths; `keeper e2e` lists the host's build inputs too, `host tests, remote Node` the Node version
  file, the lockfile and `packages/core`), when every failed job has paths, exactly one candidate
  touches them and it touches nothing outside them; a suspect is **confirmed** before anything is done
  about it, with the full tier on the commit before it (must pass) and on it (must fail), and when
  either answers otherwise the hunt bisects what is left (`refuted` names the suspect); else
  **bisect**: the full tier (`tier: full`) on the middle candidate, on a branch `queue/bisect-<sha>`
  at that commit, halving the range by its outcome until the first red commit is next to the last
  green one (`nextStep`). A probe's branch is deleted once its run has spoken; a probe cancelled twice,
  or one whose run has not finished after 2 hours (`PROBE_MAX_MS`), ends the hunt without a culprit,
  and the issue says why.
- **Known culprits** (`guard.known`: each culprit found, with its revert's pull request, or none when it
  was not reverted) are never candidates again, and neither is a revert of one (by the pull request in
  its subject) (#1259 review). A commit that still **carries** a known culprit (landed after it, before
  its revert) is probed **without** it: a commit on it with the culprit's change taken out
  (`commitWithout`, the revert's own way, pushed to the probe's branch). When the red commit itself
  carries one, its own run proves nothing: the last candidate is probed without it first, and if that
  passes the red is the known culprit's (`explained`: nothing filed or said again).
- **One red at a time, none dropped**: a hunt under way goes on, and a newer red waits for it. Once it
  has ended, the newest red not yet looked into (`guard.hunted`) starts the next hunt, over the commits
  since the last green one without what is known. Main green during a hunt (a flake) ends it. The range
  starts at the last fully green commit, not at a revert: a revert that lands while another culprit is
  on main is red too, so the commits before it may still hold one.
- **Acting** (`actOnRed`): the culprit is **reverted** in a pull request (`revert: <its subject>`,
  branch `revert/<sha>`): the reverse of its change applied to the default branch's tip in a temporary
  index from the checkout (nothing in the checkout moves) and pushed. It is **queued at the front**
  (`front`), for the session that queued the culprit (owner, author and notice address of its merged
  item), and lands through the fast tier like any change. **A release bump is never reverted** (a
  subject `chore(release): …`, or a change to project.json `release.source`); nor is anything when
  the reverse no longer applies (later commits changed the same lines) or there is no checkout: then
  the issue says to fix or revert it by hand. Either way, an issue with the failure (the run, the
  failed jobs, the first failing line, the candidates, how the culprit was found and what the queue
  did), and a message to the session that queued the culprit (its merged item, by the commit it
  landed as, else by the pull request in the subject: posted into that session as its notices are,
  and seen by its watch command). Kind `main-red`. The hunt then ends `reverting` or `reported`.
- **Acting again is safe**: a `revert/<sha>` branch an earlier try pushed is used as it is, an open pull
  request from it is the revert (not a second one), and the issue filed for a red is kept (`guard.acting`)
  until the hunt records it, so a try that stopped half way files nothing twice.
- **The release** still needs a fully green commit: its CI gate reads main's own push run (always
  the full tier) on that exact commit, never a batch's quick run on it (`ciForRelease`; test
  "refuses to tag a commit whose only green run is a batch's quick run …").
- **Keeping running**: the board holds busy while main's newest run is going or a hunt is under way
  (`queueBusy`), so the guard sees the full run that follows a landing.
- `PROJECT_BOARD_QUEUE_GUARD` (`on`/`off`), `PROJECT_BOARD_QUEUE_GUARD_MS`, `PROJECT_BOARD_QUEUE_PROBE_MS`
  and `PROJECT_BOARD_QUEUE_MAX_MAIN_RUNS` are for tests only.
  Tests: `tooling/project-board-queue.test.ts` ("the main guard …"), with a real git checkout and a
  fake `gh`.

### The integrator (#1259 step 3)

A change whose risk tier is **auto** (docs, fixture data, UI assets: `.centralu/tiers.json`) lands without
its session opening a pull request. The session pushes a branch made from main and hands it over with
**`integrate`** (`branch`, `title`, `why`, `notExercised`, `whatChanged?`, `verified?`, `closes?`, `owner?`;
model only, in `queue-tools.mjs`; the judge in `queue-integrate.mjs`).

- **Main is not protected** (no branch protection, no rulesets, 2026-10-19), but the integrator never pushes
  to main: it lands through the queue's own path, so one engine lands every change (lease, driver, batches
  of the quick tier, conflicts, notices, the main guard and its reverts), and a protected main later changes
  nothing here.
- **The judge** (`judgeBranch`): never the session's word or checkout. Main and the branch are fetched from
  GitHub into the queue's checkout (`QUEUE.conflicts.checkout`, under `refs/centralu-integrate/<pid>-<random>`,
  removed again; the checkout's branches and work are not touched), and **main's own** `scripts/tier.mjs`
  (written to a temporary folder from main, run with `--base <main> --head <branch> --json`) judges what the
  branch adds since it left main, with main's `.centralu/tiers.json`; an answer whose rules did not come from
  main is not taken. A branch that rewrites the judge or the rules is judged by main's, which call those
  files deep. No checkout, no remote, no judge or rules on main, a judge that answers nothing, or anything
  else that keeps it from being judged: deep (`unjudged`), so refused.
- **Refused**, with nothing written: no maintain or admin (then `open_pr` and `mark_ready`), a fork's branch,
  the default branch, a title whose squash subject would be over 72 characters (#1222: before any batch), a
  description the template refuses (an `open_pr` dry run), a branch not on GitHub, a branch with nothing over
  main, and any tier but auto, with the files and rules that put it there and the normal path (`open_pr`
  after the review its tier asks for, then `queue_merge`).
- **The record is a draft until the squash** (#1259 review): GitHub refuses to merge a draft, and so do
  `merge_when_green` and every version of this queue, so a board server started before this code (a session's,
  which can drive the queue for days) or a merge by hand cannot land a record it did not judge. This queue accepts
  a draft only for an item it marked `auto` (`decideBefore`, the batch's build, run and landing), and `land` readies
  it (`gh pr ready`) right before the squash, under the lease, turning it back into a draft when the squash does
  not happen, also when it throws (a rate limit, no network: `land` re-drafts, then rethrows); a poll that finds a record ready for review (a person, `mark_ready`, a driver stopped in between)
  turns it back first. Chosen over a capability flag on the lease: an older driver can take the lease after the
  hand-over, and a flag cannot stop what it does then.
- **Only through a batch**: an `auto` item's own run is CI's `changes` job alone (a draft), so `decideCi` never reads it as
  a gate: the item waits for a batch, which runs the quick tier on what lands, and needs attention (`batch`) when the
  queue cannot batch. `integrate` refuses where the queue has no batches or no two tiers of CI (`project.json`
  `queue.batch`, `ci.fullTier`), or no checkout or remote to judge in (`setup`).
- **An older board** polling the record says it is a draft and to mark it ready; `integrate`'s answer tells the session to
  leave it. If someone readies it anyway, the next poll here turns it back.
- **Labels only raise**: an open pull request taken as the record is refused when its highest `tier:<name>` label
  is above auto (`labelTier`).
- **A fetch that fails** while judging (no network, GitHub down) is refused with "integrate again", not as deep.
- **The record**: a pull request into the default branch the integrator opens itself with `open_pr`'s
  procedure (the template, the title and public-text rules; Situations checked and Usability `n/a`: no code
  runs in an auto change), its Verified carrying the integrator's Tier line, where and how it judged,
  and that it was handed over with `integrate`, labelled `tier:auto`. An open pull request from the branch is
  the record instead (handed over again after a fix; one stacked on another branch is refused).
  Chosen over a commit trailer and a board event: the main guard, its reverts, the release notes and
  `landedItem` read `(#N)`, and a trailer would need a second landing path beside the queue's.
- **Queued** for the session as `queue_merge` queues (`owner` and `author` both the given `owner`, its notice
  address), the item marked `auto` (`branch`, the `head` and `main` it judged, the Tier `line`, `at`); from
  there it is any item: kept on main, batched for the quick tier, squashed as "Title (#N)", its branch
  deleted, its news posted into the session.
- **Judged again by the queue** (`judgeHead`): on each new head a poll reads (`pollItem`, before its CI is
  read), kept on the item as `tierAt` (`head`, `main`, `tier`, `line`, `reason`), and once more inside `land`,
  right before the squash, against main as it is then (its rules may have moved since). Not auto → attention
  `tier`, once per head, to the session that handed it over: the files, and to take out what is not auto and
  push, or get its tier's review and `queue_merge` it. Such a head goes to no CI read and no batch; one stopped
  at landing ends its batch's landing as any refused merge does and keeps the judgment, so polls do not land it
  again, and gets no "Passed CI in queue/batch-N" status (`land`'s `beforeMerge` posts it once its checks
  passed). A head that **could not be judged** (a fetch that failed, the branch gone, no checkout, a fork's pull
  request) throws, so it counts as a failed poll: nothing lands meanwhile, it is tried again, and the session
  hears only after three in a row (`errorReason`); in a batch, three such failures end the batch.
  Queued with `queue_merge`, a record is an ordinary pull request again (`auto` and `tierAt` dropped).
- **Labels**: a `tier:<name>` label above auto (a person's, raised by hand) stops an integrated item on every poll
  and at the squash (`labelReason`; the queue reads labels with each pull request, `QUEUE_PR_FIELDS`).
- **Older drivers**: a watch command or app server started from a board older than this judges nothing, but it
  never lands a draft, and the record is one until this code squashes it (above), so it cannot land a record.
- Tests: `tooling/project-board-queue.test.ts` ("the integrator …"), with a real git checkout whose main
  carries this repository's judge and rules, and the fake `gh`.

## Which tool for which task (#957)

`help` (model only, read-only) answers a fixed table: which of this app's tools to use for a
repository task instead of `gh` or `git` by hand. It is a tool and not the server's instructions,
which every session would carry in its cached prompt (#512). The descriptions of the tools that
replace a `gh` command start "Instead of gh …", so a tool search for the command finds them.

## Public text, pull requests, commits and stacks (#386 step 2)

The rest of CONTRIBUTING.md as tools. The rules are pure functions in `rules.mjs`; their sources are
read from the repository on GitHub (the pull request template from the base branch, so a pull
request cannot change its own rules; `docs/commit-conventions.md` from the default branch; both kept
10 minutes; paths in `project.json` `rules`). Every tool checks everything before its first write
and refuses with every reason at once, sending nothing.

- **Public text an agent writes** (`comment`, `file_issue`, `open_pr`, and commit messages): in English (letters of
  another script are refused outside code, `> ` quotes and addresses; Greek and shared letters such
  as µ pass; Latin-script languages are not told apart), no word from the private list, no
  attribution line (`Co-Authored-By:`, "Generated with").
- **The private word list** lives in the app's data folder (`private-words.json`, through
  `centralu.readJson`/`writeJson`), never in this folder or the repository (owner decision,
  2026-10-06). Matched whole, ignoring case, anywhere, code and addresses included ("Side Quest"
  also matches `side-quest` and `side_quest`). `private_words` reads it; `edit_private_words` and the
  screen's "Private words" dialog edit it.
- **`comment`** (agents only) is the one way this app posts a comment: English, no private word,
  no attribution line. The owner's own answers are not posted at all: the screen saves them on this
  computer and an agent records them in English (above, "Reading and answering in the view").
- **Agent reading and editing:** `read_discussion` reads a body and newest comments compactly;
  `edit_comment` only edits a comment owned by the `gh` login and uses the same public-text checks.
  A bare `#N` attributed next to another repository warns: write `owner/repo#N` before publishing.
- **`file_issue`** (`title`, `body`, `labels?`, `repo?`, `dryRun?`) files through `gh api … /issues`.
- **`open_pr`** fills the template's `## ` headings from `why`, `whatChanged`, `verified`,
  `situationsChecked`, `usability`, `notExercised`, `closes` or `sections` (any heading by name, any spelling), drops a
  heading left out (the template says so) and refuses a name the template does not have. **Not
  exercised** must name something ("Nothing" is a real answer; empty, "N/A", "TBD" are not); a
  heading whose guidance says "keep the heading" (Situations checked, Usability) must not be empty. The title must pass
  the commit subject rules, since it becomes the squash subject; a title that will run past the
  length once ` (#N)` is added is a warning. `dryRun` answers the description without opening.
  When those rules pass, it runs the repository's `pnpm pre-pr` (`scripts/pre-pr.mjs`, or
  `rules.prePr` in project.json; #1181) in the checkout at `path` (default this app's), on the
  pushed head and the branches of the open pull requests under it, fetched under
  `refs/centralu-pre-pr/<one per call>/` and removed again (`pre-pr.mjs`); a ref it cannot remove
  is a warning naming it. Its findings refuse the pull request and nothing is sent; its warnings (a
  head behind main) do not, and go into Verified with the pass. `prePrExempt` leaves one check out
  (`tsc`, `orphans`, `store-step`, `guards`, `revert`) and `skipPrePr` all of them, each with a reason that goes into
  Verified. It runs outside `oneAtATime`, with progress every minute, since a stack takes minutes; a
  fork's branch cannot be fetched here and needs `skipPrePr`. Cancelled (`ctx.mcpReq.signal`) or
  past 30 minutes, the script's whole process tree is stopped (`taskkill /T` by its full path, or the
  process group), its `--cleanup` removes the worktrees and their links, and nothing is opened; a
  call cancelled while waiting for its turn opens nothing either. A release bump (`release.mjs`)
  calls `openPr` directly and does not run pre-pr: it changes version strings only, which the
  release tool has checked itself.
  With a `base` that is another open pull request's branch, it turns that one into a draft
  (`markDraft`, `gh pr ready --undo`) and says so: a stack's lower pull requests are drafts, and
  build.yml runs no CI for a draft (#1066). Refused, it is a warning, not a failure.
- **`commit_check`** (`message` or `messages`, `repo?`): the subject (`<type>(<scope>)!?: <description>`,
  a type from the conventions' table, lowercase scope and description, no trailing period, the
  subject's length in characters), a blank second line, and the public text rules. Body lines past
  the wrap and a description that reports ("added", "fixes") are warnings, not refusals. Without the
  document, the usual Conventional Commits rules, and the answer says so.
- **`rebase_stack`** (`pr`, `lower?`, `path?`, `push?`; `stack.mjs`, `git.mjs`): after the pull
  request under `pr` was squash-merged. Reads both from GitHub and their commits from the remote
  fresh at the call (the 2026-10-05 mistake was a base read earlier, which a restack had replaced),
  replays only `pr`'s own commits (after the lower one's last head) onto its merge commit in a
  temporary worktree (hooks off), and confirms before anything is pushed that the change is the one
  CI tested: the same `git patch-id` of a zero-context diff (with context, a line the base changed
  next to the pull request's edit made a clean restack look different). It then says whether the
  tree is the tested tree, or which files differ and whether that is only what the base had. It
  refuses when the lower one is not merged, `pr` does not contain the lower one's last head (it was
  built on an older version), the replay conflicts (aborted), the branch moved since GitHub was
  read, or the checkout has no remote for the repository. Without `push` it only reports; with it
  it pushes with `--force-with-lease` on the head it read and moves the base. The person's checkout
  never changes: the worktree and the app's temporary refs are removed whatever happens. `lower`
  names the lower pull request when GitHub already moved `pr`'s base to main after deleting the
  merged branch. `path` defaults to the checkout this app is in. When `pr` is a draft and no open
  pull request is based on its branch, it says to mark it ready: it is its stack's top now, and a
  draft runs no CI (#1066). It does not mark it itself: a draft may also be work in progress.
- Tests: `tooling/project-board-contribute.test.ts`, with a fake `gh` and real git repositories
  (a bare one standing for GitHub's).

## The release (#386 step 3)

docs/releasing.md as code: `release.mjs` holds the procedure, `versions.mjs` the version rules (pure),
`project.json` `release` the layout: where the version is declared (`source`: a file and a pattern
whose first group is the version; brand.ts here), the files that carry it (`versionFiles`, paths
where `*` is one folder name and `**` any number), `ignore`, `tagPrefix`, `branchPrefix`, the release
`workflow`, its `rehearsalInputs` and its `environment`. Releasing is the maintainer's act like
merging: every step but the status refuses first unless the login has maintain or admin. Owner
decision (2026-10-06): the maintainer's agent drives it end to end, approvals included, and every
step shows on the screen.

- **Read fresh at every call**: main's commit and the tags from the remote (`git fetch`/`ls-remote`
  under refs of the call's own, removed again), CI on main from GitHub, the release workflow's runs.
  `release_status` (read-only, agents and the screen's "Release" dialog) answers the phase
  (`ready-to-tag`, `tagged`, `publishing`, `waiting-approval`, `released`, `failed`), the release
  commit and how far behind main it is (#1350), CI on it, the checkout's state, the rehearsal or the release run, the jobs waiting for approval, what merged since
  the last tag (the release notes draft, without `chore(release)` commits) and the next step.
- **Release CI sources (#633 review):** match GitHub Actions check-suite ids to runs of the
  configured CI workflow files and exact commit/event (main push or PR). Release/rehearsal checks
  can have the same job names and never replace CI checks. Before every npm-publish approval,
  require only the tagged commit's own green CI; no PR fallback and no gate on later main commits.
  Cancelled builds name their run id and rerun command; a successful new attempt replaces the old
  cancellation. Generated release bumps have their own build concurrency group per commit.
  Status reports this publication gate. The inline event scan does not follow called scripts or
  actions; review those manually as described in docs/releasing.md.
- **The release commit (#1350):** a release is cut from the bump's own squash commit, not main's head.
  `releaseCommit` walks main's first-parent history back from its head to the first commit that
  does not declare main's version (`release.source`); that commit is the default for `rehearse` and
  `tag`, and `commit` names another one of that run (main's head among them). A version main no
  longer declares (a later commit changed it, a newer bump) is refused, by `version` or by `commit`.
  Everything the release reads is read at that commit: CI, the version files, the rehearsals (those on
  it, and those on the bump branch at a commit with its tree), the PR evidence. What lands after it
  does not matter, and a rehearsal of main's head does not count (only runs on the release commit, or
  on the bump branch at a commit with its tree). The notes run from the last tag to the release commit;
  what came after is listed as "Not in this release". A shallow checkout whose history stops before
  the bump is refused (the boundary is not the bump). `tag` and `rehearse`
  need a clean checkout, not one on main or at main (the tag is pushed by id); `bump` still does.
  Off main's head `rehearse` pushes the commit to `branchPrefix` + the version (never moved: a branch
  there with another tree is refused) and dispatches the workflow on it; `tag` deletes that branch
  after the push when it is still at the release commit (a bump PR's head is not).
- **CI evidence for rehearse and tag (#629):** CI on the release commit green is used directly and its
  failure always blocks. Otherwise the merged bump PR may supply green required checks only when the
  release commit is its single-parent squash commit and the PR head has the identical Git tree. Audit required workflow
  jobs for event/branch behavior first; such jobs or unmapped required names require main CI. Both
  steps and status say which evidence they used, or why it was refused. Bump still needs main CI.
- **`release`** (`step`, `confirm?`, `path?`): each step checks everything first and refuses with every
  reason at once; without `confirm: true` it says what it would do and does nothing.
  - `bump` (`version?` or `bump?` = prerelease/patch/minor/major, `notes?`, `closes?`): needs the
    checkout clean, on main and at main's commit on the remote, CI green, main's version tagged
    (released), the new version after it and after the latest tag, untagged, and no branch or open pull
    request for it yet. Every file in `versionFiles` must carry main's version as a quoted string, and
    no other tracked text file outside `release.ignore` may carry it, including suffixes and template
    strings (`git grep` on main's commit, no extension filter; each hit is reported as `file:line`).
    `ignore` explicitly allows historical docs, release notes and lockfiles; intentional fixture pins
    need an exact path there. `versionFiles` wins over `ignore`. See docs/releasing.md. The bump
    replaces the quoted version only (prose like "removed in 0.1.0-beta.16" stays), commits it on main
    in a temporary index (the checkout, its index and branches never move), pushes
    `chore/release-<version>` (never forced) and opens the pull request through `open_pr`'s own code,
    checked with `dryRun` before the push: the merged list under Why, the files under What changed.
    It warns, never refuses, when other builds' jobs (running plus queued, of every active run) reach
    three quarters of `release.runners` (default 20): the bump PR's CI would queue behind them (#1035).
  - `rehearse`: CI green on the release commit, the version untagged and its files consistent; starts the workflow on main (or, when main has moved past the release commit, on a branch at it)
    with `rehearsalInputs` (`dry_run=true`: builds and packs, publishes nothing, asks no approval).
    A rehearsal already running or passed on that commit is not started again. While main's version
    is released (#1035), it rehearses the open bump PR instead: on its branch, with no CI required,
    when exactly one `branchPrefix` branch after main's version has an open PR into main (or
    `version` names it), its head is the PR's head, main's head is an ancestor of it (else the
    squash would give main another tree), and it carries that version consistently and untagged.
  - `tag` (`version?`, `commit?`, `skipRehearsal?`): a clean checkout, CI green on the release commit, main's version after the
    latest tag and untagged (a release tag is never moved), its files consistent, and a successful
    rehearsal on that commit, or on `branchPrefix` + the version at a commit with its tree (the
    bump PR's rehearsal; the rule #629 uses for its CI), unless `skipRehearsal: true`. The newest of
    those counts. Pushes the tag on the release commit by its id
    (lightweight, as before; no local tag is made) and answers the release run.
  - `approve` (`version?`, `comment?`): only the tag's release run (event push, head the tag, on the
    tag's commit), only the configured environment, only what GitHub says this login may approve
    (`current_user_can_approve`); otherwise it names the reviewers and the run's address. Says which
    jobs wait; the shim's approval is the last reversible moment (docs/releasing.md). The gate: the
    tagged commit's own CI green, and before the shim also every other job of the run succeeded and
    every package `release.registry.packages` names (but `release.registry.shim`) on the registry at
    the version with `gitHead` the tagged commit (`PROJECT_BOARD_NPM_REGISTRY` points the tests at a
    local one). `wait: true` with `confirm` (#1035) reads that gate every poll until it passes and
    approves at once, up to `waitMinutes` (default 45, at most 60), with progress; a gate that cannot
    pass by itself (failed CI or job, a package from other code, no permission) refuses at once, and a
    timeout approves nothing and says what it still waited for. A waiting call does not hold other
    board writes up (`serially` is skipped for it). The required set is the tagged commit's own
    workflow's (`readRequired` with `at`), and a required check missing after every build run on it
    completed refuses. A wait pins the version, tagged commit and run of its first read and refuses
    if any changes; no job listed as waiting is "not yet"; an aborted call never approves.
  - With duplicate tag runs, status chooses one waiting on the configured environment (otherwise the
    newest active run), names the duplicates, and offers `cancel_duplicate` only before publishing.
- **Never run a `release` step against the real repository in a test**: the tests use a fake `gh`
  and push to a bare repository through `pushurl`.
- Tests: `tooling/project-board-release.test.ts`. It also holds `versionFiles` to this repository: the
  files they name are exactly the files that carry `APP_VERSION` as a quoted string, and a bump of the
  real files leaves none of them behind.

## Files

- `centralu.app.json` — the manifest. `id` is `project-board` and must stay equal to this folder's
  name. `home` is the tool Centralu calls to open the screen.
- `server.mjs` — the MCP server: it only registers the tools, from the families below, in `ORDER` (the
  order agents and the screen list them). A new tool goes in its family's `tools` and in `ORDER`.
- The tool families, each a `tools` table of `{ config, handler }`: `view-tools.mjs` (`show` and the
  screen's resource), `board-tools.mjs` (list_items, get_items, set_item_fields, add_item),
  `reader-tools.mjs` (read_item, read_discussion), `decision-tools.mjs` (the owner's saved answers,
  decision_summaries, list_needs_decision), `contribute-tools.mjs` (comment, edit_comment, file_issue,
  open_pr, commit_check, rebase_stack), `ci-tools.mjs` (ci_status, merge_when_green,
  mark_ready, read_failed_job), `queue-tools.mjs` (queue_merge, integrate, merge_queue, unqueue), `help-tools.mjs` (help),
  `release-tools.mjs` (release_status, release), `words-tools.mjs` (private_words,
  edit_private_words).
- What the families share: `config.mjs` (project.json, read once at start), `board.mjs` (the cached
  board, an item's line in answers, `itemOf` for every reference), `threads.mjs` (the reader's cached
  threads), `reply.mjs` (answers and failures), `handlers.mjs` (`oneAtATime`, and `answering`,
  `forView` and `serially`, which every handler goes through).
- `github.mjs` — every call to GitHub, through `gh`. `project.json` — which project, and the CI settings.
- `ci.mjs` — the CI and merge decisions as pure functions (no gh, no IO).
- `queue.mjs`, `queue-driver.mjs`, `bin/merge-queue.mjs` — the merge queue's decisions (pure), its file,
  lease and polls, and the watch command. `batch.mjs`, `queue-batch.mjs` — its batches: the rules
  (pure) and their steps on GitHub. `run-failure.mjs` — why a CI run failed, real or infrastructure
  (pure: the rerun policy). `queue-conflict.mjs` — the git work of a conflict. `queue-integrate.mjs` —
  the integrator's judge of a branch's tier, and the record's texts (#1259 step 3).
- `markdown.mjs` — GitHub Markdown to safe HTML for the reader, and the decision summary parser (pure).
- `rules.mjs` — the rules for public text, commit messages and the pull request template (pure).
- `answers.mjs` — the owner's saved answers: save, delete, mark recorded (pure; decision-tools.mjs keeps them in the data folder).
- `stack.mjs`, `git.mjs` — rebase_stack's procedure, and local git through `execFile`.
- `pre-pr.mjs` — open_pr's run of the repository's `scripts/pre-pr.mjs` on the pushed branches.
- `release.mjs`, `versions.mjs` — the release procedure, and the version rules (pure).
- `cache.mjs`, `util.mjs` — the short cache the board and the threads share, and small helpers
  (`sleep`, `mapLimit`, `short`, `plural`) the modules share (pure).
- `ui/index.html` — the screen. Change it. It is read on every open, so edits show without a restart.
- `runtime/` — **generated by Centralu. Never edit, format, move, or read it in full.** It is replaced
  when Centralu updates. Everything you need is imported from `./runtime/centralu-app-runtime.mjs`:
  `McpServer`, `serveStdio`, `z` (zod), `centralu`, `inputRequired`, `acceptedContent`.

## Rules

1. **No installs.** No `npm install`, no `package.json`, no imports other than Node built-ins
   (`node:*`) and the runtime. The app must start with `node server.mjs` alone.
2. **Tool names** use letters, digits, `_` or `-`. **Never `__`** (two underscores separate names
   in agent sessions; Centralu drops such tools).
3. **Register tools with `centralu.tool(server, name, config, handler)`** (same arguments as
   `server.registerTool`). The handler then knows which call it is serving, which
   `centralu.agent()` needs.
4. **Annotate every tool**: `annotations: { readOnlyHint: true }` if it only reads,
   `readOnlyHint: false` if it changes anything. Read-only tools run without asking the person;
   the others follow the session's approval setting. The same hint decides refreshes: every call to
   a tool that is not `readOnlyHint: true` tells this app's open screens to read again (rule 8). A
   read tool left unannotated costs a refresh cycle each time it is called, and screens that re-read
   with it keep refreshing each other.
   A write may also declare its risk in `_meta`, so the person is not asked for every call (docs/apps.md,
   "A write can declare how risky it is"): `'centralu/risk': 'local'` for bookkeeping in this app's own
   data (with `destructiveHint: false`), `'routine'` for an ordinary write of this project's own pull
   requests, issues and queue (no card in a trusted project's own app under `normal`), and
   `'centralu/askWhen': { push: true, path: '*' }` to ask for a call where any named argument holds that value
   (`'*'`: is set at all). This app declares `ack`, `unqueue` and `mark_answer_recorded` local, and `comment`,
   `edit_comment`, `file_issue`, `open_pr` and `rebase_stack` (both ask when `path` names a checkout of the
   caller's choosing, whose scripts and hooks they would run outside the session's sandbox; `rebase_stack` also
   when `push` is true), `set_item_fields`, `add_item`, `mark_ready`, `queue_merge`, `merge_when_green` and
   `integrate` routine. `release` and `edit_private_words` declare nothing and always ask (a session refused for
   a private word must not be able to remove it unasked and post again). A new write declares nothing until its
   risk is judged.
5. **Visibility**: by default a tool is visible to agents and to the screen. A tool only the screen
   should call gets `_meta: { ui: { visibility: ['app'] } }`; one only agents should call gets
   `['model']`.
6. **A tool with a screen** gets `_meta: { ui: { resourceUri: 'ui://project-board/…' } }`, and the
   resource is registered with `centralu.uiResource(server, name, uri, new URL('./ui/…', import.meta.url))`.
   The `home` tool must have one and must be visible to the screen.
7. **State lives in the server, never in the screen.** Keep it in memory and save it in the data
   folder with `await centralu.readJson(file, fallback)` / `await centralu.writeJson(file, value)`
   (or any file under `centralu.dataDir`). **Never write files into this folder** — a project app's
   folder is committed to git and shared with the team. The screen may not use browser storage
   (it runs in an isolated frame).
8. **The screen re-reads, it does not remember.** When anyone calls one of this app's tools that
   is not `readOnlyHint: true`, Centralu sends open screens `centralu/notifications/changed` (the
   screen that made the call does not get it: it already has the answer); the template's screen
   then calls `show` again. Keep that handler, and keep `show` read-only.
9. **stdout is the MCP channel.** `console.log` is redirected to stderr for you; never write to
   `process.stdout` yourself. stderr is shown to the person when the app fails.
10. **Asking the agent**: inside a tool handler, `await centralu.agent('prompt', { schema, tool })`
    asks the agent of the person using Centralu. Each call runs in a new session under this app
    (the person can read it), with the `safe` approval setting, and returns the agent's final
    answer: text, or with `schema` (a JSON Schema whose top level is an object) JSON of that shape,
    checked by Centralu. Under `safe` the agent reads without asking, but every file write and
    command waits for the person to approve it in that session, so ask the agent for an answer and
    do the writing in your own tool code. Declare `"uses": { "agent": true }` in the manifest for the person's
    default agent, or a list such as `["codex"]` to pick one with `tool`. The prompt reaches the
    agent marked as written by this app, not by the person, so say plainly what you need. A run
    takes seconds to minutes; the helper keeps the call alive while it waits. An app runs one agent
    at a time and at most 5 a minute: put a batch of work into one prompt instead of a loop.
11. **Calling another app**: inside a tool handler, `await centralu.callApp('other-app', 'tool', args)`
    calls a tool of another app and returns its answer (JSON if the tool returns structured
    content, else text). Declare the app in `"uses": { "apps": ["other-app"] }`. Only tools open to
    agents (visibility `model`) can be called. A project app reaches apps of its own project first,
    then apps in the person's user folder; an app in the user folder reaches only user-folder apps.
    A chain of apps calling apps stops at 3 calls deep, and an app tool already in the chain cannot
    be called again from inside it.
12. **Reading Centralu's data**: inside a tool handler, `await centralu.host('sessions.list')` or
    `await centralu.host('git.status')` returns JSON. These two names are the whole list; declare
    each one you use in `"uses": { "host": [...] }`. `sessions.list` gives this project's sessions
    (the names shown in the sidebar and their states, never the conversations); `git.status` gives this project's branch and changed
    files (project apps only).

All three throw an error that says what Centralu answered. The first time the app uses each of them (an
agent tool, another app, a host name), Centralu asks the person once — on the session's approval card
when an agent's call started it, on this app's screen when the screen did — and remembers the answer
until the manifest's `uses` changes. The call waits while the person decides (up to 5 minutes). A
refusal comes back as that error: show it plainly instead of retrying.

## The screen's look

- **Everything comes from Centralu's theme** (docs/apps.md §6.5): colours, sizes, line heights,
  fonts, weights, radii and the border width are MCP Apps variables, applied on `<html>` by
  `applyTheme`. Their fallbacks (Centralu's dark values) are in the `:root` block at the top of the
  stylesheet and nowhere else; every rule reads those names. Spacing stays literal.
- **Narrow first** (docs/apps.md §6.6): under 520px the columns stack, the decision column first,
  and the board scrolls as one page, with a row of status tabs above it that jump to a section and
  mark the one in view (`renderTabs`, `markTab`). Keep that working when you change the layout.

## Checking your work

- Call Centralu's **`check`** tool after changes. It validates the manifest, starts the app, lists
  its tools for real, reads every screen the tools point to, and reports problems (tool names,
  visibility, missing annotations, a `home` without a screen) with the app's stderr.
- Centralu restarts the app once at the end of your turn if this folder changed; calls in progress
  finish first. Agents in other sessions see changed tools from their next turn (Claude) or next
  thread (Codex).
- Errors in `server.mjs` and the modules it imports are printed with file and line. A failure inside
  `runtime/` is almost always a wrong argument from them — look at the first frame outside `runtime/`.
