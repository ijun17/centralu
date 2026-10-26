# The OS layer: the code that knows the OS, and the tests that run on every OS

Issue [#1599](https://github.com/ijun17/centralu/issues/1599). Owner direction, 2026-10-26: encapsulate the code that
touches the operating system in one layer, so that more and more logic does not know which OS it runs on; CI runs the
layer's tests on every OS and the rest once, on Linux.

Status: proposed 2026-10-26. The first pull request brings this document, the measurement (§2), the lint rule with its
allowlist (§5) and the Windows job's selection (§6). Later pull requests move host areas behind the layer (§7), each
shrinking the allowlist. This is the TypeScript half of the OS layer [runtime-unification.md](runtime-unification.md)
§3.3 describes for the runtime's Rust (`keeper/src/os/`).

## 1. Summary

- **Where the Windows time goes.** On main's last green full run, the Windows unit tests spent 4,457 file-seconds over
  687 test files, in two shards of 19.1 and 11.4 job-minutes. 98 % of that time is in tests that touch the OS, by the
  rule below. Two board tests (`tooling/project-board-queue.test.ts`, `-release.test.ts`) are 1,736 s, 39 %, and
  vitest's count-based `--shard` put both in shard 1.
- **What this pull request removes.** The packages that are already OS-free leave the Windows job: 258 of 687 test
  files, but only 93 file-seconds, 2.1 %. Its gain in minutes is the time-balanced split (§6.4): each shard gets
  about 2,180 measured seconds, so the quick tier's Windows wait goes from 19.1 to about 16 minutes (§2.3).
- **Where the minutes are.** In the board's tests (§2.4: the next pull request gives the board its own OS seam and a
  fake), then in the host's areas that start real processes, git and worktrees (§7).
- **The measure of progress** is the allowlist: 384 files today (123 shipped, 261 tests).

## 2. Measured

### 2.1 What the Windows jobs run

From `.github/workflows/build.yml` and the run of main `f369f5c` (run 40303859800, 2026-10-26):

| Job | Tier | Runs | Job time |
|---|---|---|---|
| `windows tests` | full | `pnpm lint`, `pnpm depcruise`, `pnpm typecheck`; no tests | 2.8 min |
| `windows tests (vitest 1/2)`, `(vitest 2/2)` | quick (every pull request) and full | `vitest run --shard=N/2`: every test file of both vitest projects (`unit`, `app-runtime`), 687 files, halved by count | 19.1 and 11.4 min (vitest's own `Duration` 1,090 s and 625 s) |
| `host tests, remote Node (windows-2022)` | full, when the host's tests changed | `vitest run packages/agent-host packages/protocol tooling/launcher-` on the remotes' pinned Node: 459 files | 17.8 min (vitest 895 s) |

The issue's batch-227 numbers (18.4 + 10.5 and 16.3 runner-minutes) are the same shape.

### 2.2 Per file

Per-file durations are vitest's own, read from the CI log of the two unit shards (non-TTY output prints each file's
time), and from a local run on a Windows 11 PC (`vitest run --maxWorkers=4 --reporter=json`, 980 s wall, 3,450
file-seconds; the shares agree within a few points). "File-seconds" adds up each file's time; the shards run several
files at once, so a job's minutes are less than its file-seconds divided by 60.

CI, Windows unit shards, by area. **W**: still runs on Windows after this pull request; **L**: Linux only.

| Area | Files W | Seconds W | Files L | Seconds L |
|---|---:|---:|---:|---:|
| `tooling/project-board-*` (the board app's tests) | 10 | 2,065 | 1 | 0 |
| `agent-host/sessions` | 139 | 736 | 7 | 0 |
| `agent-host/dev-services` | 50 | 409 | 4 | 0 |
| `agent-host/links` | 21 | 405 | 5 | 0 |
| `agent-host/apps` | 30 | 209 | 2 | 0 |
| `agent-host/adapters` | 90 | 137 | 9 | 0 |
| `agent-host` top level | 33 | 121 | 9 | 1 |
| `tooling`, other | 19 | 125 | 43 | 57 |
| `tooling/launcher-*` | 7 | 65 | 1 | 0 |
| `agent-host/lifecycle`, `mail`, `transport`, `views`, `keeper` | 27 | 63 | 12 | 0 |
| `packages/platform` | 2 | 25 | 19 | 1 |
| `packages/ui` | 0 | 0 | 115 | 34 |
| `packages/core`, `packages/protocol` | 1 | 0 | 31 | 2 |
| **Total** | **429** | **4,364** | **258** | **93** |

The slowest files on Windows: `project-board-queue` 875 s, `project-board-release` 861 s, `sessions/manager-worktree`
168 s, `dev-services/worktree-recovery` 142 s, `links/links` 118 s, `project-board-contribute` 110 s,
`links/dev-build` 79 s, `sessions/start-agent` 77 s, `links/auto-reconnect` 66 s, `links/install-windows` 59 s.

By whether the file itself imports `fs`, `child_process`, `os` or `path` (local run): `agent-host` 233 files that do
(1,458 s) and 205 that do not (142 s); tooling 68 that do (1,807 s) and 13 that do not (3 s); `ui`, `core` none.

### 2.3 What Windows spends now, and what each step removes

Windows unit job-minutes now: 30.5 (19.1 + 11.4) per pull request and per full run; the quick tier waits on the
longer shard, 19.1. The remote-Node Windows job adds 17.8 on a full run that changes the host (unchanged, owner).

After this pull request, expected: each shard holds about 2,180 measured file-seconds. The shards ran about 2.7
files at once (shard 1: 2,930 s of tests in 1,090 s), which gives about 810 s, but a shard cannot end before its
longest file: `project-board-queue`, 875 s. With the job's setup (about 50 s), choosing the tests (17–25 s) and
vitest's collection, each shard should take about 16 minutes: the quick tier's Windows wait drops from 19.1 to about
16 minutes, and the job-minutes stay about 32 (the same tests, evenly split). Below 875 s per shard takes the board's
two files getting cheaper, which is what §2.4 is for.

| Step | Removes from the Windows unit job (file-seconds, CI) |
|---|---|
| 2, this pull request: the OS-free packages and tooling guards leave; shards balanced by time | 93 of 4,457 (2.1 %); the longer shard from 19.1 to about 16 minutes |
| Next: the board's OS seam and fake (§2.4) | about half of the two files' 1,736 s (measured locally: −60 % and −32 %); with it the longest file, which bounds a shard |
| 3a, store and files | ≤ 60 test files picked only through `dev-services/store.ts` and `sessions/cross-project.test-helpers.ts`; about 50 s |
| 3b, worktrees | ≤ 310 s in `manager-worktree` and `worktree-recovery` alone; ≤ 409 s for `dev-services` |
| 3c, adapters' spawning | ≤ 137 s (`adapters`); 35 more test files reach the Claude and Codex adapters' index |
| 3d, links and ssh | ≤ 403 s, most of it real processes that stay (§7) |
| 3e, apps runtime | ≤ 209 s, mostly real Node processes that stay |
| 3f, keeper-facing parts | ≤ 40 s |

The "≤" is an upper bound: a test leaves Windows only when neither it nor anything it imports touches the OS, so an
area's integration tests (a real git, a real process) stay, as they should.

### 2.4 Why the board's two files take so long on Windows

Measured on the Windows PC above (both files about 2× faster there than on the Windows runner: queue 500 s against
875 s, release 419 s against 861 s; Linux CI 246 s and 141 s), counting each process the tests start.

The time is processes started one after another, and an app start and stop per test:

| Per test that starts the board | Queue file (174 of 248 tests) | Release file (87 of 104 tests) |
|---|---|---|
| Fake `gh` calls | 26.6, about 63 ms each: 1.7 s, about 60 % | 28, about 61 ms each: 1.7 s, about 35 % |
| Real `git` processes | 16.5 (42 in the 69 tests with a git fixture), about 19 ms each | about 90 (63 from the app, 27 from the fixture), about 18 ms each: 1.75 s, about 35 % |
| App start, MCP handshake, `tools/list` | 1, about 0.2 s | 1, about 0.2 s |
| Stop (`dispose`, a PowerShell `Get-CimInstance` listing of the tree) | 1, about 0.3 s | 1, about 0.3 s |
| Repositories made (`origin.git` and `work`) | 2 in the git tests | 2, about 0.9 s of fixture |
| Mean per test | 2.9 s | 4.8 s |

Unit costs on Windows: a fake `gh` call is a launcher `.exe` (the .NET runtime, about 30 ms), then `node` (about 30 ms),
each with a console host; `git` 11–24 ms for a local command, about 150 ms for a push; `node -e 0` 28 ms.

Why so many `gh` calls: the board polls every 50 ms, and each call takes about 63 ms, so a waiting test runs `gh` back
to back for as long as it waits. About 28 % of the queue file's calls re-read what never changes within a test
(repository permissions, `build.yml`, branch protection and rules); the release file's hot calls are the release
workflow's runs, branch protection and rules, and check runs. Its git calls are mostly `show`, `rev-parse`, `config`,
`fetch` and `update-ref`.

What the next pull request does, by time saved:

1. **The board's own OS seam**: its `gh`, `git` and file calls behind one module, with an in-memory fake that most
   queue and release tests use. The fake `gh` alone is about 290 of the queue file's 500 s and about 150 of the
   release file's 419 s here; on the fake, git and the stop go too. A few tests keep the real git, the real files and
   the fake `gh` process, on every OS.
2. **Fewer reads per poll**: what does not change within a run (permissions, protection, rules, the workflow file)
   read once; repeated `git show` and `rev-parse` through one `git cat-file --batch`. About a quarter of the queue's
   `gh` calls, and fewer calls against GitHub itself.
3. **Shared fixtures and a cheaper stop**: the release fixture built once per file and copied (about 80 s here), and
   no process listing when the app's tree is already gone (about 80 s over both files).

**Done in the board's first step (#1599, the pull request after #1600).** The board app starts every program through one
module, `.centralu/apps/project-board/system.mjs` (gh, git, Node, the conflict commands), which also keeps the merge
queue's clock. Two test-only switches use it:

- `PROJECT_BOARD_FAKE_PROGRAMS`: the fake `gh` script, unchanged, answers in the app's own process instead of being
  started (`fakeGh(root, script, { inProcess: true })`): no launcher, no Node, no console host per call.
- `PROJECT_BOARD_QUEUE_STEP=read`: the queue ticks once per `merge_queue` read, never on a timer, each tick 100 ms later
  on its own clock. The tests step it (`until`, `polls`) instead of sleeping; the 15 sleeps of the queue file are gone,
  and a test reads the queue at the poll that acted (three tests had read it one poll later by luck of the timer).

Measured on the Windows PC above, both files together with two workers, this branch and then main right after it (the
load of the machine changes over an hour: an earlier pair took 1,612 and 1,464 s on main, 200 and 305 s here):

| File | Tests | Before | After |
|---|---:|---:|---:|
| `project-board-queue.test.ts` | 259, 260 after | 612 s | 245 s (−60 %) |
| `project-board-release.test.ts` | 104 | 538 s | 366 s (−32 %) |

On the Windows runner (this step's own CI, build run 40355280437): the queue file 375 s (875 before), the release file
652 s (861). `tooling/test-durations.json` was refreshed from that run: each shard now holds 1,974 measured seconds
(2,180 before), and no single file bounds a shard any more.

What is left: a queue test is now its app's start and stop (about 0.5 s with the PowerShell listing at stop) and, in
the 69 with a git fixture, real git; a release test is real git (its fixture repositories and the app's own git, about
90 processes) and the app's start and stop. `tooling/project-board-system.test.ts` starts the real programs (the fake
`gh` through its launcher, Windows' quoting, stdin, exit codes, a missing program) and holds the in-process fake to
the same answers; it stays on every OS.

**Still on every OS, and why.** Both files start the app through the real app runtime
(`packages/agent-host/src/apps/external/runtime.ts`), a Node process per test, so by the selection's rule they touch the
OS and stay in the Windows list. Taking them off it is the next step: the app run in the test's own process, its data
files behind the same seam (the queue file, the lease, `opened-prs.json`), and git faked for the queue tests that build
no fixture. The release tests check real git (tags, a temporary index, pushes to a bare repository) and keep it; the
release flow's git is the board's real-git test.

## 3. What the OS layer is

Today it is a handful of modules, each owning one subject, that `local/platform-checks`
(`tooling/eslint-platform-checks.js`) already lets ask which OS this is (docs/architecture.md §2):

| Module | Subject |
|---|---|
| `agent-host/src/os.ts` | the host's questions named for what differs: `hasPs`, `clonesFiles`, `locksRunningPrograms`, `pathsOf`, `installedCopyPath`, `systemTool` |
| `agent-host/src/env-path.ts`, `tool-launch.ts` | finding a tool on PATH (PATHEXT, npm shims) and starting it (`.cmd` shims) |
| `agent-host/src/dev-services/kill-tree.ts` | ending a process tree: groups and signals, or taskkill and parent links |
| `agent-host/src/dev-services/terminal.ts` | the terminal's and the Run button's shell |
| `agent-host/src/adapters/claude/exe-link.ts` | how Claude Code is started on Windows |
| `agent-host/src/dev-services/project-folder.ts` | a new project's folder and each OS's folder-name rules |
| `packaging/npm/centralu/bin/platform.mjs`, `serve-*.mjs` | the npm launcher's platform layer |

`tooling/os-layer.js` is now the one definition: `OS_LAYER` (those modules), `PLATFORM_MODULES` (the layer, plus
`links/**` and the launcher's `centralu.mjs`, parked there before the layer had a name; they may ask the OS, but what
in them touches it is on the allowlist), `osModule` (which imports touch the OS), `isChecked` (which code is held to
it), `inOsLayer` and the allowlist. `eslint.config.js` and the selection both read it.

**Growing `OS_LAYER` is a deep-tier change, by design.** The allowlist can only shrink, but a file added to `OS_LAYER`
may touch the OS without being on it, so a new entry is the one way to let new OS use in without the list growing.
That is what the layer is for when the file carries an OS subject of its own, and a way around the rule when it does
not. No test can tell the two apart; a reviewer can. `tooling/os-layer.js` is a guard (`tooling/**` in
`.centralu/tiers.json`), so `pnpm tier` rates a change to it deep, and it is reviewed in a separate deep review session.

## 4. What the layer owns

The layer carries the OS's semantics, not only its calls: a caller should not be able to tell which OS it is on. That
is where the Windows-only bugs have come from (#1559: a link that is a junction, not a symlink).

| Subject | What differs | What the layer answers |
|---|---|---|
| Path form and case | separators; drive letters and UNC; `C:\a` and `c:\A` the same folder on Windows and macOS (by default), not on Linux; 8.3 short names; `realpath` through junctions | one path type the host passes around; `samePath(a, b)`, `isInside(root, p)` under the OS's case rule; the wire form stays `protocol/paths.ts` |
| Line endings | git's `autocrlf` checks text out with CRLF on Windows; tools write either | `readText` returns what is on disk; `lines()` splits on both; writers say which they write |
| Links and junctions | a directory symlink needs a privilege on Windows, so a junction stands in; `lstat` and `readlink` see them differently; deleting a junction must not follow it | `link(target, at)` makes the kind the OS allows and says which; `isLink`, `removeLink` that never recurse into the target |
| Locks | Windows refuses to delete or rename an open or running file (`EBUSY`, `EPERM`), and a virus scanner holds new files for a moment | `rename`, `remove` with the retries Windows needs; `locksRunningPrograms` (exists today) |
| Quoting and shells | `cmd.exe` rules and `.cmd` shims vs POSIX `sh`; PowerShell's own | a command as an argument list; the layer quotes for the shell it starts, the caller never builds a command string |
| Process trees and signals | process groups and signals on POSIX; no groups and no SIGTERM on Windows (taskkill, Job Objects) | `spawn` that contains the child, `stop(child, grace)`, `killTree`; exit reasons in one shape |
| Environment | `PATH` vs `Path` (case-insensitive keys on Windows), `PATHEXT`, `HOME` vs `USERPROFILE`, temp folders | `env` read case-correctly; `homeDir`, `tempDir`, `findTool` |

## 5. The rule and the allowlist

`local/os-imports` (in `tooling/eslint-platform-checks.js`, beside `local/platform-checks`) reports an import of
`fs`, `fs/promises`, `child_process`, `os`, `path`, `net`, `http`, `https`, `dgram` or `worker_threads`, bare or
`node:`, or of the installed `node-pty` (the terminal's pseudo console), `better-sqlite3` (SQLite's files and locks)
and `ws` (WebSockets on real sockets), static, `export … from`, `import()` or
`require`, in the checked code (`packages/*/src`, `apps/*/src`, `packaging/**/*.mjs`, tests included) outside the
layer, its tests (a layer module's own test or test helper beside it, named for it exactly: `os.test.ts`,
`kill-tree.test.ts`; `os.anything.test.ts` is not) and the files on `tooling/os-allowlist.txt`. A type-only
import runs nothing, and `import { posix, win32 } from 'node:path'` reads paths the same way everywhere, so neither is
reported. Build and release scripts, tooling and e2e are not checked: they work on the repository.

It also reports the OS reached without importing an OS module: `process.kill`, `process.cwd()`, `process.chdir()`,
`process.execPath` and `process.env.PATH` (any case, as Windows reads it) (`OS_PROCESS_USES`), and `fileURLToPath`
and `pathToFileURL` from `node:url` (`OS_NAMED_EXPORTS`), which convert by the OS's path rules. `process` is Node's
unless the file declares its own, also as `globalThis.process` or through `node:process`; a use counts as a member
(`env['Path']`, ``env[`PATH`]``) or in an object pattern (`const { cwd } = process`). Not seen: a computed key
(`process[name]`), `process.env` or a `node:url` namespace kept in a variable and read later, `require('node:url')`
read in place, a computed `import()`, and a `require` made by `createRequire` under another name.

`tooling/os-layer.test.ts` holds the list to the truth and lets it only shrink:

- the list equals the checked files that touch the OS outside the layer (`tsx tooling/os-tests.ts --offenders`): a
  file that moved behind the layer, or is gone, takes its line out in the same change;
- no line may be new against main's list where this branch left it, except a file git sees renamed
  (`git diff -M`), whose line follows it;
- sorted, unique, none in the layer.

Today: 384 files, 123 shipped (119 host, 4 launcher) and 261 tests (258 host, 2 `platform`, 1 `protocol`). Adding
`net`, `node-pty` and `better-sqlite3` (owner's session, 2026-10-26) put 9 more files on it; `http`, `https`, `dgram`,
`ws`, `worker_threads` and the uses of `process` and `node:url` (the deep review) 22 more.

**`path` is not staged separately.** Of the 127 checked source files that import an OS module, 10 import only `path`
(4 tests do); `path` is the most imported (85 files) but nearly always beside `fs`. Leaving `path` out would shrink the
list by 14 lines and leave the same files on it.

## 6. The CI selection

### 6.1 The rule

`tooling/os-tests.ts` picks a test to run on every OS when:

1. it is in the layer (a layer module's test), or named in `EVERY_OS_TESTS` (`tooling/os-layer.js`, with a reason);
2. it asks which OS this is (`local/platform-checks`' own judgement: a test that skips a case on Windows);
3. it is checked code and imports an OS module itself (it is on the allowlist);
4. anything it imports, directly or through other modules, is in the layer, or is checked code or one of the
   repository's own apps (`.centralu/apps/`, which run on the person's machine) that imports an OS module or asks
   which OS it is.

Every judgement is the lint rules' own: the script runs `local/os-imports` (with `everywhere: true`) and
`local/platform-checks` on each file through ESLint's `Linter`, and follows what each file loads as the rule reads it
(`loadedSpecifier`: static and `export … from`, `import()`, `require`, `process.getBuiltinModule`,
`import x = require`, each with a constant string), plus `vi.mock` and `vi.importActual` paths; relative specifiers
and the `@cc/*` aliases resolve, and one that cannot fails the script rather than leaving a test out. Tooling and
scripts do not count in (4): a tooling test that reads the repository with `fs` (a guard) runs on Linux only, while one
that imports the launcher or a host helper that starts processes runs everywhere.

Not seen: what §5 lists as not seen by the rule, and a process started by path (`EVERY_OS_TESTS` names those, `launcher-node-floor` today). Modules outside the list
(`node:crypto`, `node:url` but its path conversions) do not count.

### 6.2 Where it applies

`windows tests (vitest N/2)` runs `tsx tooling/os-tests.ts --shard N/2 --out <list>` and then vitest with
`CC_TEST_FILES=<list>` (`vitest.config.ts` runs only the listed files, each in its project, and refuses a line that
is not an existing repository path). Both tiers, every pull request and every full run, `workflow_dispatch`
included: the list does not depend on what changed. Linux (`verify`) runs every test. The remote-Node job and e2e
are unchanged (out of scope, #1599; the remote-Node job stays as it is, owner's session 2026-10-26).

Skipping the Windows job on a pull request that reaches none of the selected tests (only `packages/ui`, say) is to
be proposed once the selection has run green on a few pull requests.

### 6.3 Cost

The script globs the tests through vitest's own configuration and scans the files they reach: 17 s on the Windows PC
above, pnpm and tsx starting included. Each shard computes it. A job of its own that computes it once, on Linux, and
hands the lists to the shards was considered and not done: its setup is about 21 s (checkout, pnpm, Node, install;
the `verify` job's steps on the same run) plus the scan and a runner's pickup, and both shards would wait for it
before starting at all, so the quick tier's wait would grow by about 40 s to save 17 s of each shard's runner time.
`tooling/os-layer.test.ts` checks that a listed run runs exactly the list.

### 6.4 Shards balanced by measured time

Vitest's `--shard` splits by file count. `tooling/os-tests.ts --shard i/n` splits the selected tests by time instead:
longest first, each to the lighter shard (`balance`), ties by path, so both shards compute the same split. The times
are `tooling/test-durations.json`, each test file's seconds on the Windows runner. A file it does not name (a new
test) weighs the median of those it does, at least one second. Today: 256 and 174 files, 2,181 and 2,180 seconds.

**Refreshing the times.** Every Windows shard writes vitest's JSON report next to its usual output and keeps it as the
artifact `windows-test-times-<shard>` (30 days). To refresh, from a green run on main:

```sh
gh run download <run id> -p 'windows-test-times-*' -D /tmp/times
pnpm exec tsx tooling/os-tests.ts --refresh-durations /tmp/times/*/vitest-times.json
```

and commit the file. The first version was read from run 40303859800's log, which prints each file's time. Times
that are a little old only make the split a little uneven; a refresh is due when a shard runs more than a few
minutes longer than the other, or after a step of §7 moves many tests off Windows. `os-layer.test.ts` checks the
file is as the refresh writes it and names a time for most of the selected tests.

## 7. Moving the host behind the layer

Each move is a pull request that puts an area's OS calls behind the layer's interface, gives its logic tests an
in-memory implementation, keeps a few integration tests on the real OS, and takes the area's lines off the allowlist.

### 7.1 Interface and fake

The layer's operations are an interface the host is given (as the store and the platform ports are), with a real
implementation per OS family and one in memory:

```ts
interface Os {
  files: {
    readText(p: HostPath): Promise<string>
    write(p: HostPath, data: string | Uint8Array, opts?: { atomic?: boolean }): Promise<void>
    list(dir: HostPath): Promise<Entry[]>
    stat(p: HostPath): Promise<Stat | null>
    rename(from: HostPath, to: HostPath): Promise<void> // retries what Windows locks
    remove(p: HostPath, opts?: { recursive?: boolean }): Promise<void> // never through a link
    link(target: HostPath, at: HostPath): Promise<'symlink' | 'junction'>
  }
  paths: { join(...parts: string[]): HostPath; same(a: HostPath, b: HostPath): boolean; inside(root: HostPath, p: HostPath): boolean }
  processes: { start(cmd: Command, opts: StartOptions): Child; stop(child: Child, graceMs: number): Promise<Exit> }
  env: { get(name: string): string | undefined; home: HostPath; temp: HostPath; findTool(name: string): Promise<HostPath | null> }
}
```

`memoryOs({ as: 'windows' | 'posix' })` keeps a file tree in memory and follows the chosen OS's rules: case-folding,
`\` paths, junctions in place of directory symlinks, a rename of an open file refused. Logic tests then cover Windows
semantics on Linux, which they do not today, and leave the Windows job.

### 7.2 Order

By Windows time saved and risk:

| # | Area | Why here |
|---|---|---|
| 3a | Store and files: `dev-services/store.ts`, the data folder, session files | 60 test files reach the OS only through `store.ts` and the cross-project helpers; plain file operations, low risk; everything later builds on the fake |
| 3b | Worktrees: `sessions/manager-worktree`, `dev-services/worktree-*`, `git-*` | the largest host time (≥ 310 s) and where #1559 came from; the decisions (which worktree, recovery) go against the fake, a few real-git tests stay on every OS |
| 3c | Adapters' spawning: Claude, Codex, ACP | 137 s and 35 more test files that reach the adapters' index; a fake process replaces the spawn in the adapter tests |
| 3d | Links and ssh | 403 s, but mostly real processes (`install-windows`, `dev-build`, tunnels) that stay; remote phase 3 is changing it (the reason `links/**` is parked) |
| 3e | Apps runtime | 208 s of real Node processes per app; placement and discovery (files) move, the runtime tests stay |
| 3f | Keeper-facing parts: `lifecycle/`, `keeper/`, the handover | small (≤ 40 s) and the highest risk; with runtime-unification's steps |

## 8. Decisions and open questions

Answered by the owner's session, 2026-10-26:

1. **The board's tests stay on Windows** (the board app runs on Windows too). They get cheaper the way the product does:
   the board's git, gh and file calls behind one module of its own with an in-memory fake, most queue and release
   tests on the fake, a few real-git and real-file tests on every OS. The next pull request; §2.4 is its measurement.
2. **Shards balanced by measured time**: in this pull request (§6.4).
3. **`node:net`, `node-pty` and `better-sqlite3` are OS modules**: in this pull request (§5). The deep review added
   `http`, `https`, `dgram`, `ws` and `worker_threads`, and the OS uses of `process` and `node:url`. The socket tests
   `transport/server`, `views/view-host`, `links/linked-views`, `links/remote-client`, `views/origin-ports` and
   `tooling/rpc-recovery` (a real `HostServer` across a host restart) are back on Windows.
4. **The remote-Node Windows job stays as it is.**
5. **Skipping the Windows job** on a pull request that reaches no selected test: proposed after the selection has run
   green on a few pull requests.

Filed from the deep review, not in this pull request: #1612 (a view origin port Windows reserves fails with
`EACCES` instead of moving on; the test's port finder already skips it) and #1613 (the shards read main's latest
measured times on their own, so nobody has to run `--refresh-durations`).

Open: **macOS** has no unit job; the selection is what one would run.

## 9. How it could fail, and what holds

| Way it could fail | What holds |
|---|---|
| A Windows-only bug in a file the selection drops | Only files that neither touch the OS nor reach anything in the checked code that does are dropped; a test that skips a case by OS is kept |
| A new file touches the OS outside the layer | `local/os-imports` fails lint; listing it fails `os-layer.test.ts` (no new line against main) |
| A test reaches the layer only indirectly | Imports are followed transitively, through tooling and scripts as well, and through `@cc/*` aliases |
| An import the script cannot follow (a typo, a moved file) | The script fails, so the Windows job fails, rather than leaving the test out |
| A listed file renamed | Its line follows the rename git sees (`git mv`, also with edits); a copy, a split or a new file at the old path gets no line |
| main's list unreadable while main has the layer | The comparison fails instead of passing |
| A listed test path vitest cannot match | `vitest.config.ts` refuses a `CC_TEST_FILES` line that is not an existing repository path with `/` |
| A dynamic import of a computed path, or a process started by path | Not seen by imports; such a test is named in `EVERY_OS_TESTS`, or it asks the OS (it usually does) |
| The measured times go stale, or a new test has none | The split only gets uneven, never drops a test: `balance` places every selected file; a new one weighs the median |
| The list and vitest's projects disagree | `vitestFiles` globs through vitest's own configuration; `os-layer.test.ts` checks a listed run runs exactly the list in both projects |
