# Repository configuration and project trust

A project the user has not marked trusted cannot change how its sessions ask for approval
(#92). Claude sessions load only the user's own settings (`settingSources: ['user']`), so
the repository's `.claude/` settings, local settings, hooks, commands and `CLAUDE.md` do
not apply. Codex threads are started with the project's paths marked `untrusted` for that
thread only, and `project_doc_max_bytes = 0`. That keeps the repository's `.codex/config.toml`,
hooks, exec rules and `AGENTS.md` out, and it stops Codex from persisting the folder as
trusted in `~/.codex/config.toml` on first use. The user's own settings in `~/.claude` and
`~/.codex` still decide under the `normal` preset. What a session reads follows from what the
session is, not from whether it carries Centralu's own tools (#152). Only the Assistant and
coordinators read no settings files, trusted or not: they belong to no project and work in a folder
other sessions can write to (in Claude, `settingSources: []`, which leaves out `~/.claude` too, except
the person's own `defaultMode`, carried under `normal` since #382; in Codex, their folder is marked
`untrusted` and `project_doc_max_bytes = 0`, while `~/.codex` still loads). Agents a session started (in its folder or a worktree) and the builders of project apps follow their project's trust
like any worker. The builder of a user-folder app counts as trusted, because that folder is the user's own
(decision 3).

The same switch decides whether the project's apps may run (M4 decision 3; [apps.md](../apps.md) §3).
An untrusted project's apps are discovered and listed with the reason, but never started, never
attached to a session, and every call to them is refused; no app or builder is created there.
Trust is re-read at every app call, not only when an app is attached (`runtime.ts` `call`,
`session-apps.ts`; tests "an app in an untrusted project never starts even when a request
arrives", "turning off trust immediately stops a running app", "a call after trust is lost is
blocked — checked again on every call, not only when it attached").
What this closed was measured with the real CLI (#152, `scripts/probe-project-trust.mts`, CLI
2.1.282): a committed `settings.json` allow rule was already ignored by the CLI; the holes were
`settings.local.json` allow rules and a project hook answering "allow", which turned the approval
card off even under `safe`.

How projects get trust: a project registered now starts untrusted, and the sidebar asks once when
it is added, whether the person added it or allowed the Assistant's `add_project` card (#1220; the host names the
project in `projects_changed.added`). The exception is a new empty folder Centralu made itself (`projects.create` or `create_project`
without a Git source, here or on a linked machine, #655): only the person and Centralu wrote there, so it starts
trusted. A clone stays untrusted, because an agent can ask for any URL and the contents come from outside. The `trusted` column arrived untrusted by default (store v33); v35 then marked every
project that existed at that moment as trusted, once, so an update did not silently start ignoring
the `.claude/` settings of folders the user had chosen and worked in. v35 does not run again, so
trust turned off later stays off.

Limits:

- Trust is read when a session's tool process starts. Changing it affects running sessions'
  repository settings at their next restart or resume. Apps follow at once: a project that loses
  trust has its running apps stopped and detached immediately.
- Projects that existed before v35 were trusted without being asked.
- Codex still loads repository skills (`.codex/skills`, `.agents/skills`) in untrusted
  folders. They are instructions only; whatever they lead the model to do still passes approval.
- The Codex behaviour is verified from Codex source and the installed binary's strings, not
  by a logged-in run.

## Git before trust (#407)

A folder copied from somewhere (a zip, a shared drive) carries its own `.git/config` and
`.git/hooks`, and plain git reads run several of the programs named there. Measured against a
planted copy with git 2.54: `status` runs `core.fsmonitor`, the clean filter of each file whose stat
data no longer matches the index, and the `post-index-change` hook when it rewrites the index;
`check-ignore` and `ls-files` run `core.fsmonitor`; `diff` and `show` run textconv drivers and smudge
and clean filters; `log` and `show` run `gpg.program` on a signed commit when `log.showSignature`
is set; `worktree add` runs `post-checkout`, `reference-transaction` and smudge filters. The host
reads a project as soon as it is added (`projects.list` asks for its branch and change count), so
every one of these was reachable before the person answered the trust question.

**Before a project is trusted, no git read the host makes runs a program the repository chose.**
Every git the host starts goes through `runGit` (`dev-services/git-exec.ts`); the lint rule `guard/git-start`
(`tooling/eslint-guards.js`) fails if any other source starts git. A read for an untrusted project gets:

- `--no-optional-locks`, so the index is not rewritten and the folder is left as it was found;
- `-c core.hooksPath=<null device>` (`/dev/null`, or `\\.\nul` on Windows), under which no hook
  can exist;
- `-c core.fsmonitor=` (empty reads as off in every git; `false` is a boolean only from 2.36);
- `-c log.showSignature=false`, so no signature is verified and `gpg.program` never starts;
- for every filter driver git would see in that folder (listed first with
  `git config --get-regexp '^filter\.'` under the same flags, so `include.path` and `includeIf`
  resolve exactly as for the read), `clean`, `smudge` and `process` set to no command and
  `required` to false. The user's own drivers (Git LFS) are turned off too;
- `--no-textconv --no-ext-diff` on `diff`, `show` and `log`, and `--ignore-submodules=all` on
  `status` and `diff`: a submodule has its own config, whose drivers were not listed.

The listing is its own git process before each read. Saving a worktree's work before its deletion
(#608) makes about fifteen calls in one folder, so its reads share one listing per repository
(`gitFilterListings`, #368). What the shared listing covers: the reads of refs, history, trees and
the index (`rev-parse`, `rev-list`, `log --raw`, `ls-tree`, `ls-files`, `diff --cached`, `bundle
create`), none of which runs a filter. The one call of the save that runs clean filters, `add -A`
into the save's private index, comes after the history scans and the bundle, which can take
minutes. The cleanup stops only the session being deleted: the project's other sessions keep
running, can write a driver into the configuration the worktree shares, and the worktree's
`.gitattributes` can name it. So `read-tree` and `add -A` take a listing of their own, made right
before them. What is left is the window every read before trust already had between its listing
and the call. A planted configuration is on disk before the save starts and is turned off as
before. Calls that change which configuration git reads (`GIT_DIR`, `GIT_CONFIG_*`) never share
a listing: it is keyed by folder alone.

Command-line configuration outranks every configuration file and is handed to the git processes
git starts itself, so an included file or a nested call cannot undo it. The reads this covers are
the change count and branch (`projects.list`, `projects.gitStatus`, the app broker's status),
`git.status`, `git.diff` (tracked and untracked), `git.log`, `git.commitDetail`, `git.branches`,
`git.ignoredEntries`, the `git.checkout` dry run, the file tree's `check-ignore`, file search's
`ls-files`, a project app's version history, and the worktree dirty check. A worktree session
cannot be started in an untrusted project at all: checking out runs the repository's filters and
hooks by design, turning them off would leave files they never converted (an LFS pointer, a
git-crypt blob) for the session to edit and commit back, and `--no-checkout` would leave an empty
folder. The manager refuses with the reason, and `gitWorktreeAdd` refuses too unless told the
project is trusted.

A new worktree forks from the project's trunk **as the remote has it** (#1484): `resolveForkBase` runs
one `git fetch` of the trunk, which reads the repository's network settings (`core.sshCommand`, a
credential helper, `core.gitProxy`, `url.*.insteadOf`), so it runs only in a trusted project, as
the checkout does, with a prompt-free environment (`cloneEnv`) and a 20-second bound. An untrusted
project forks from the local trunk ref and the start answer says it was not fetched. Test:
`git-worktree.test.ts` "an untrusted project is not fetched".

What a read still does before trust: it reads the repository's files, its configuration and any
file that configuration includes, and `core.excludesFile`. It does not start a pager (stdout is a
pipe) or an editor, and it does not touch the network, so `core.sshCommand` and
`credential.helper` are never read. `safe.directory` is left to git: git honours it only from the
user's own and the system configuration, and the host never sets it, so a folder owned by another
user is refused as it would be in a terminal.

A trusted project's reads run as plain git does (fsmonitor stays on for the checkout dry run and
the worktree dirty check, which can otherwise approach the 10-second limit on a large repository).
`git.log` runs locked for every project; the signature check it skips only printed into output
the parser never read. Tests: `git-untrusted.test.ts` runs each read against the planted copy and
requires no marker, with the same read for a trusted project as the control; `manager-projects.test.ts`
"runs none of the repository's programs before project trust, through every door that reads it".

Limits:

- **Writes the person asks for run as plain git does, trusted or not.** Stage runs clean filters;
  commit runs `pre-commit`, `commit-msg` and `post-commit` and may sign with `gpg.program`;
  switching branches runs `post-checkout` and smudge filters; push runs `pre-push`, credential
  helpers and `core.sshCommand`. Turning filters off would change what gets committed, so these
  are not locked; they happen only on the person's click.
- Before trust, status does not look inside submodules. The untrusted worktree dirty check counts
  each submodule as a change, so a removal asks first.
- Before trust, a file under a clean filter (Git LFS) whose stat data changed shows as modified,
  and diffs show raw content without textconv.
- A filter driver whose name contains `=` cannot be named in `-c`; the read is refused instead.
- The driver list is read just before the read. Something that changes `.git/config` in between
  is already running on the machine.
- The Windows null-device hooks path is covered by the Windows CI job running these tests; no
  person has run it on a Windows machine.
