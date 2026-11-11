# What the keeper's children and handoff taught

## Children the keeper holds

The keeper held them from #280 step 2 until #1895 step 4: what was learned stays here, and each lesson says where its
guard went.

**CH5. An agent's stdout is a protocol: never drop a byte.**
Happened: claude was measured buffering 60 s with stdout unread; one codex `thread/resume` answer was 23 MB on one
line; Node's `readline` cut that line in two and the resume hung forever (448815d2).
Rule: buffer losslessly up to 64 MiB, then stop reading so the child blocks; hand over whole lines only; a lost
reader's half line goes whole to the next; only whole lines reach the child's stdin. Readers split on `\n` by hand.
Guard: `host/adapters/codex/client.test.ts` "a 24MB single-line response arrives intact" (the keeper side went with #1895 step 4 PR 2, which removed its children service).
Platforms: all.

**CH8. The keeper's stop escalates in a fixed order.**
Rule: the host stops its own children first (up to 6 s); then stdin EOF for pipes and SIGHUP for ptys; TERM to the
group after 2 s; KILL 1 s later; then `children.sock` is removed. A pty's signals go to every group in its session,
its shell's jobs included (#840 item 2).
Guard: `scripts/keeper-integration.mjs` scenario `update` check "stop ends the keeper, the host and its N children" (the
host's own children since #1895 step 4 PR 1). The keeper's own escalation went with its children service in PR 2: its
stop now tells the host `{"op":"stop"}` on its stdin and waits up to 6 s (`host_proc::STOP_WAIT`).
Platforms: macOS, Linux.

**CH13. Without a keeper the host owns its children.**
Rule: the host spawns and stops its children itself, on every path. Since #1895 step 4 PR 1 it never connects to
`children.sock`, so there is no fallback left to guard; `scripts/keeper-integration.mjs` scenario `update` checks that
the host runs its terminal and dev server itself under a keeper.
Platforms: all.

**CH14. A kept process pins the CLI it started with.**
Happened: the keeper can hold an agent process forever, so a session keeps running the CLI that was installed when it
started (#297).
Rule: an idle, quiet (60 s) session on an older CLI is restarted on the installed one; unknown on either side is not
older; versions are read without running npm's program.
Guard: `host/agent-versions.test.ts` "restarts a live, idle, quiet session that runs an older CLI";
`host/sessions/agent-versions-direct.test.ts` (the held-child case of `agent-versions-restart.test.ts` went with #1895
step 4 PR 1).
Platforms: all.

## The keeper handoff

The keeper handed itself over from #280 step 4 until #1895 step 4 PR 4: what was learned stays here, and each lesson
says where its guard went.

**HD13. A running executable that is unlinked keeps running; one overwritten in place may not.**
Happened: `tauri build` deletes and rewrites the bundle; `centralu install` does `rmSync` then `ditto`. A probe that
overwrote a running keeper's file in place saw it answer for 3 s, but any page not yet loaded comes from the new file.
Rule: nothing overwrites a running executable in place; replace by unlink or rename.
The rule stays: a keeper beside the window and the window itself run from the bundle an install replaces.
Guard: **UNGUARDED** since #1895 step 4 PR 4 (`keeper-handoff-integration.mjs` checked that keeper A kept answering
from its unlinked executable).
Platforms: macOS, Linux.
