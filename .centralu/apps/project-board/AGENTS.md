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

- **`queue_merge`** (`pr`, `lowers?`, `owner?`, `deleteBranch?`; model only): one pull request, or a
  stack as `pr` (its top) and `lowers` (the ones under it), which land as one squash through the top
  after its base is moved to the default branch; the lowers are then closed with "Landed in #N".
  Refuses at once, as `merge_when_green` does, without maintain or admin, for a draft or a closed pull
  request, and for a top based on a branch none of its lowers has. A pull request is in one item only.
  `owner` names the queuing session (default a new id); the answer gives the watch command. Queued
  again (what an attention message may ask for), an item is looked at afresh: its clocks and failure
  count start over, a merge GitHub refused is tried again, reruns spent on its head stay spent, and
  without a new `owner` it stays the first session's, whose watch command listens for that owner.
- **`merge_queue`** (`all?`; read-only, agents and the screen) and **`unqueue`** (`pr`; changes nothing
  on GitHub).
- **Each poll** reads one item (`decideBefore`, `decideCi`): no maintain or admin, a draft, DIRTY,
  BEHIND, BLOCKED, a squash subject over 72 characters, or a base that is not the default branch or a
  lower's branch → attention. Only the CI workflows' own checks count (`readWorkflowChecks`, their
  check suites: a release job of the same name is not CI, #624), and the run to rerun is the PR's own
  pull_request run when a push run shares the commit (`latestRuns`). A cancelled run is rerun once per
  head and failed jobs once per head (`gh api …/rerun`, `…/rerun-failed-jobs`), written down before
  asking and counted as done only once its attempt number moves; GitHub refusing the rerun, failing
  again or cancelled again → attention, naming the job and its first failing line. No run on a head
  for 15 minutes, or a required check never reported for 20 minutes while nothing else runs (a renamed
  job, a path-filtered workflow) → attention. A head that moved starts over (reruns, required set,
  clocks, attention). Green and **CLEAN only** (an unattended queue is strict: UNSTABLE, HAS_HOOKS and
  UNKNOWN wait, and after 30 minutes → attention; one exception, #1015: UNSTABLE when every check on
  the head passed or belongs to a run of a CI workflow that a successful run on the same head made
  moot, cancelled or older, and every commit status succeeded, as a cancelled duplicate pull_request
  run left #971 UNSTABLE for good; `onlySupersededFailures`. Landed as usual, nothing rerun: a rerun
  of the duplicate would spend a whole CI run to change nothing) → every open lower must be inside the top's head
  (compare: the green run, read on that head, ran on all of them) and no lower's own latest CI run on
  its head may have failed (cancelled or none is fine; a red one means the top's run may not cover it,
  → attention `lower-failed`), then squash with `--match-head-commit` on the head read, subject `Title (#N)` without
  attribution lines (`squashMessage`, as `merge_when_green`). Only GitHub's word that it merged counts:
  `gh pr merge` can exit 0 under GitHub's own merge queue without merging (→ attention, not asked again
  on that head). A stack lands only when the top merged into the default branch, here or found merged
  (a driver stopped between the merge and writing it down, or by hand): then each head branch is
  deleted and the lowers closed, a branch kept when another open pull request is based on it (deleting
  it would close that one). Found merged into another branch, nothing is closed or deleted. Never
  `--auto`, never `--delete-branch`, never a force push.
- **Failures on one item** that are not an outage (a pull request gone, a write GitHub refuses) are
  counted; three in a row → attention, once.
- **Gentle on GitHub**: one item per tick (5 s), each item again after its own wait (90 s while CI
  runs, 2 min while it needs attention), the required set read once per head, the permission once per
  10 minutes. A rate limit (`rate`, now in `FATAL`), no network or no login pauses the whole queue,
  from 1 minute doubling to 15, shown in `merge_queue`.
- **Where it lives**: `merge-queue.json` in the app's data folder, read and written whole and
  synchronously for each change, so it survives the server restarting. A file that does not read
  stops the driver, said once in the app's log, then tried again with a growing wait. Centralu stops an app with no
  open screen and no call after 5 minutes (docs/apps.md §4), and an app cannot message a session on
  its own (§13), so the queue has two drivers: this server while it runs, and the **watch command** a
  session runs in the background. One drives at a time through `merge-queue.lease.json` (renewed
  every tick and before every write, free after 3 minutes of silence or as soon as its process is gone,
  let go on exit).
- **Telling the session**: every change worth a message is an event with a sequence number and the
  item's owner. Attention is one event per change (`noticeKey`: the reason, the head and the job), not
  one per poll; a merge or a close is one too. `node .centralu/apps/project-board/bin/merge-queue.mjs
  watch --data <folder> --owner <name> --after <seq>` (queue_merge answers it whole) drives the queue
  while it waits and exits with that owner's messages: 3 when one needs attention, 0 for a merge or
  when nothing is left, 6 at its deadline (`--minutes`, default 100), 2 for a wrong argument or an
  unreadable queue, 130 or 143 when stopped by SIGINT or SIGTERM (the tick in flight finishes and is
  written down first). It names the command to run again, quoted like queue_merge's (`shellQuote`). A Claude session is woken when a background command ends.
- **The screen** shows a "Merge queue" section above the board while it has items: needs attention
  (with why), CI, waiting, merged in the last day, each with Unqueue while active. Nothing tells a
  screen when the driver moves an item, so it reads `merge_queue` again every 15 s while one is active.
- `PROJECT_BOARD_QUEUE_TICK_MS` and `PROJECT_BOARD_QUEUE_POLL_MS` shorten the waits only for tests.
  Tests: `tooling/project-board-queue.test.ts` (the decisions, the app against a fake `gh` that
  records every write, a restart, the watch command), and the screen in `e2e/fixtures/board-reader.ts`.

### Batches (#962)

The free plan runs about one CI build at a time, so pull requests queued together each waited for
their own run in one line. `batch.mjs` holds the rules (pure), `queue-batch.mjs` does them on GitHub,
and the tick drives the running batch before any item, under the same lease. On while `project.json`
has `queue.batch` (`min` items to start one, at least 2; `max`, default 6).

- **Which**: active items in CI whose own CI was read on their head and has not started (every run
  `queued`, `waiting`, `requested` or `pending`: cancelling it throws no work away), not sent back
  from a batch on that head (`batchless`), not a fork's (its head would run CI in this repository's
  branch) and not a release bump (its CI is the release's evidence), the oldest first, in one
  repository. Sent back, an item is batchable again only after its own next poll. One batch runs at a
  time; an item in a batch is not polled on its own (`dueItem`).
- **Building**: each member is read again (still open, not a draft, not DIRTY, the same head). A
  branch `queue/batch-<n>` is made at the default branch (never moved: one that exists ends the
  batch), and each head is merged into it in order on GitHub (`POST /merges`); one that conflicts
  goes on with its own CI and is not batched again on that head; so does one GitHub will not merge
  into it for another reason (a 404 or 422, a head gone, already in main). With two or more merged, the CI
  workflows are started on the branch (`workflow_dispatch`); GitHub refusing that (no trigger, no
  permission) ends the batch and makes none for an hour (`batchOff`), before anything is cancelled.
  Then the members' own runs that have not started are cancelled, each written down before it is
  cancelled (`cancelled`, which a batch split or re-formed from this one keeps for its members).
- **CI on the batch** is read as an item's head is (`decideRun`, shared with `decideCi`): the
  required set from the default branch plus jobs the batch adds, a cancelled run rerun once, failed
  jobs once. A member that changes meanwhile (pushed, closed, a draft, taken out, queued again) ends
  the run; the rest are tried again without it. **Red** (failed twice): split in halves, a half of
  two or more tried again, one alone goes back to its own CI. Anything else (no run in 15 minutes, a
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
  does not stop it when every check that did not pass is a run the batch cancelled
  (`onlyCancelledByBatch`); anything else waits 30 minutes, then the rest go back. Before each merge
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
  `usability`, `notExercised`, `closes` or `sections` (any heading by name, any spelling), drops a
  heading left out (the template says so) and refuses a name the template does not have. **Not
  exercised** must name something ("Nothing" is a real answer; empty, "N/A", "TBD" are not); a
  heading whose guidance says "keep the heading" (Usability) must not be empty. The title must pass
  the commit subject rules, since it becomes the squash subject; a title that will run past the
  length once ` (#N)` is added is a warning. `dryRun` answers the description without opening.
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
  merged branch. `path` defaults to the checkout this app is in.
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
  (`ready-to-tag`, `tagged`, `publishing`, `waiting-approval`, `released`, `failed`), CI on main, the
  checkout's state, the rehearsal or the release run, the jobs waiting for approval, what merged since
  the last tag (the release notes draft, without `chore(release)` commits) and the next step.
- **Release CI sources (#633 review):** match GitHub Actions check-suite ids to runs of the
  configured CI workflow files and exact commit/event (main push or PR). Release/rehearsal checks
  can have the same job names and never replace CI checks. Before every npm-publish approval,
  require only the tagged commit's own green CI; no PR fallback and no gate on later main commits.
  Cancelled builds name their run id and rerun command; a successful new attempt replaces the old
  cancellation. Generated release bumps have their own build concurrency group per commit.
  Status reports this publication gate. The inline event scan does not follow called scripts or
  actions; review those manually as described in docs/releasing.md.
- **CI evidence for rehearse and tag (#629):** main green is used directly and main failure always
  blocks. Otherwise the merged bump PR may supply green required checks only when main is its
  single-parent squash commit and the PR head has the identical Git tree. Audit required workflow
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
  - `rehearse`: CI green, the version untagged and its files consistent; starts the workflow on main
    with `rehearsalInputs` (`dry_run=true`: builds and packs, publishes nothing, asks no approval).
    A rehearsal already running or passed on that commit is not started again. While main's version
    is released (#1035), it rehearses the open bump PR instead: on its branch, with no CI required,
    when exactly one `branchPrefix` branch after main's version has an open PR into main (or
    `version` names it), its head is the PR's head, main's head is an ancestor of it (else the
    squash would give main another tree), and it carries that version consistently and untagged.
  - `tag` (`version?`, `skipRehearsal?`): the checkout as for bump, CI green, main's version after the
    latest tag and untagged (a release tag is never moved), its files consistent, and a successful
    rehearsal on that commit, or on `branchPrefix` + the version at a commit with main's tree (the
    bump PR's rehearsal; the rule #629 uses for its CI), unless `skipRehearsal: true`. The newest of
    those counts. Pushes the tag on main's commit by its id
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
  mark_ready, read_failed_job), `queue-tools.mjs` (queue_merge, merge_queue, unqueue), `help-tools.mjs` (help),
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
  (pure) and their steps on GitHub.
- `markdown.mjs` — GitHub Markdown to safe HTML for the reader, and the decision summary parser (pure).
- `rules.mjs` — the rules for public text, commit messages and the pull request template (pure).
- `answers.mjs` — the owner's saved answers: save, delete, mark recorded (pure; decision-tools.mjs keeps them in the data folder).
- `stack.mjs`, `git.mjs` — rebase_stack's procedure, and local git through `execFile`.
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
