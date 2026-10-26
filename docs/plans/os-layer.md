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
  rule below. Two board tests (`tooling/project-board-queue.test.ts`, `-release.test.ts`) are 1,736 s, 39 %, and both
  fall in shard 1.
- **What this pull request removes.** The packages that are already OS-free leave the Windows job: 269 of 687 test
  files, but only 106 file-seconds, 2.4 %. Computing the list costs about as much again on each shard (§6.3). The
  gain of step 2 is the rule and the measure, not minutes.
- **Where the minutes are.** In the host's areas that start real processes, git and worktrees (§7), and in the
  board's tests (§8, a question for the owner).
- **The measure of progress** is the allowlist: 353 files today (109 shipped, 244 tests).

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
| `agent-host/dev-services` | 49 | 409 | 5 | 0 |
| `agent-host/links` | 19 | 403 | 7 | 3 |
| `agent-host/apps` | 29 | 208 | 3 | 0 |
| `agent-host/adapters` | 90 | 137 | 9 | 0 |
| `agent-host` top level | 32 | 121 | 10 | 1 |
| `tooling`, other | 18 | 124 | 44 | 58 |
| `tooling/launcher-*` | 7 | 65 | 1 | 0 |
| `agent-host/lifecycle`, `mail`, `transport`, `views`, `keeper` | 22 | 56 | 17 | 7 |
| `packages/platform` | 2 | 25 | 19 | 1 |
| `packages/ui` | 0 | 0 | 115 | 34 |
| `packages/core`, `packages/protocol` | 1 | 0 | 31 | 2 |
| **Total** | **418** | **4,351** | **269** | **106** |

The slowest files on Windows: `project-board-queue` 875 s, `project-board-release` 861 s, `sessions/manager-worktree`
168 s, `dev-services/worktree-recovery` 142 s, `links/links` 118 s, `project-board-contribute` 110 s,
`links/dev-build` 79 s, `sessions/start-agent` 77 s, `links/auto-reconnect` 66 s, `links/install-windows` 59 s.

By whether the file itself imports `fs`, `child_process`, `os` or `path` (local run): `agent-host` 233 files that do
(1,458 s) and 205 that do not (142 s); tooling 68 that do (1,807 s) and 13 that do not (3 s); `ui`, `core` none.

### 2.3 What Windows spends now, and what each step removes

Windows unit job-minutes now: 30.5 (19.1 + 11.4) per full run and per pull request. The remote-Node Windows job adds
17.8 on a full run that changes the host.

| Step | Removes from the Windows unit job (file-seconds, CI) |
|---|---|
| 2, this pull request: the OS-free packages and tooling guards leave | 106 of 4,457 (2.4 %); the selection itself costs about 17 s per shard (§6.3) |
| 3a, store and files | ≤ 60 test files picked only through `dev-services/store.ts` and `sessions/cross-project.test-helpers.ts`; about 50 s |
| 3b, worktrees | ≤ 310 s in `manager-worktree` and `worktree-recovery` alone; ≤ 409 s for `dev-services` |
| 3c, adapters' spawning | ≤ 137 s (`adapters`); 35 more test files reach the Claude and Codex adapters' index |
| 3d, links and ssh | ≤ 403 s, most of it real processes that stay (§7) |
| 3e, apps runtime | ≤ 208 s, mostly real Node processes that stay |
| 3f, keeper-facing parts | ≤ 40 s |
| Board tests (§8, owner) | up to 2,065 s |

The "≤" is an upper bound: a test leaves Windows only when neither it nor anything it imports touches the OS, so an
area's integration tests (a real git, a real process) stay, as they should.

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
`fs`, `fs/promises`, `child_process`, `os` or `path`, bare or `node:`, static, `export … from`, `import()` or
`require`, in the checked code (`packages/*/src`, `apps/*/src`, `packaging/**/*.mjs`, tests included) outside the
layer, its tests (`os.test.ts`, `kill-tree.windows.test.ts`) and the files on `tooling/os-allowlist.txt`. A type-only
import runs nothing, and `import { posix, win32 } from 'node:path'` reads paths the same way everywhere, so neither is
reported. Build and release scripts, tooling and e2e are not checked: they work on the repository.

`tooling/os-layer.test.ts` holds the list to the truth and lets it only shrink:

- the list equals the checked files that touch the OS outside the layer (`tsx tooling/os-tests.ts --offenders`): a
  file that moved behind the layer, or is gone, takes its line out in the same change;
- no line may be new against main's list where this branch left it, except a file git sees renamed
  (`git diff -M`), whose line follows it;
- sorted, unique, none in the layer.

Today: 353 files, 109 shipped (106 host, 3 launcher) and 244 tests (241 host, 2 `platform`, 1 `protocol`).

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

Not seen: a computed specifier, a `require` made by `createRequire` under another name, a process started by path
(`EVERY_OS_TESTS` names those, `launcher-node-floor` today), and modules outside the five (`node:net`,
`node:sqlite`, `node-pty`): the real-socket tests `transport/server`, `views/origin-ports`, `view-host` and
`links/linked-views` leave the Windows job by this. Whether `node:net` belongs to the layer is §8's question 6.

### 6.2 Where it applies

`windows tests (vitest N/2)` runs `tsx tooling/os-tests.ts --out <list>` and then vitest with `CC_TEST_FILES=<list>`
(`vitest.config.ts` runs only the listed files, each in its project). Both tiers, every pull request and every full
run, `workflow_dispatch` included: the list does not depend on what changed. Linux (`verify`) runs every test. The
remote-Node job and e2e are unchanged (out of scope, #1599).

### 6.3 Cost

The script globs the tests through vitest's own configuration and scans the files they reach: 17 s on the Windows PC
above, pnpm and tsx starting included; each shard computes the same list, so the job pays it twice.
`tooling/os-layer.test.ts` checks that a listed run runs exactly the list.

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

## 8. Open questions for the owner

1. **The board's tests** are 46 % of the Windows unit time (2,065 s), two files 1,736 s. They test the project-board
   app (`.centralu/apps/project-board`), which runs wherever Centralu does, with real git repositories and fake `gh`
   processes. Run them on Linux only, with a small Windows subset? Or make them cheaper (one repository per file)?
2. **Shard balance.** Vitest shards split by file count, so both big board files land in shard 1 (19.1 min against
   11.4). Splitting the two files, or a duration-balanced shard list from the measured times, would bring the quick
   tier's Windows wait to about 15 minutes with nothing removed. Proposed, not changed.
3. **The remote-Node Windows job** runs every host test again on the pinned Node (17.8 min). Running only the
   selected ones there would remove little today (99 % of its time is selected); worth revisiting after 3a–3c.
4. **The quick tier** keeps the Windows unit job on every pull request, as decided 2026-10-18. A pull request that
   changes nothing the selection reaches (only `packages/ui`, say) could skip it; not proposed until the list is
   shorter, since today it would rarely apply.
5. **macOS** has no unit job; the selection is what one would run.
6. **Sockets.** The rule covers the five modules the direction named. `node:net` (and the native `node-pty`,
   `better-sqlite3`) also behave differently per OS; adding `net` would keep four socket tests (about 10 s) on
   Windows and put a few more files on the list. Proposed, not done.

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
| The list and vitest's projects disagree | `vitestFiles` globs through vitest's own configuration; `os-layer.test.ts` checks a listed run runs exactly the list in both projects |
