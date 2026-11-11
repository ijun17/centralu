# Deleting a worktree child and recovering its work

**Deleting a worktree child** (#608, decision owner 2026-10-13). In every preset the parent decides whether
to remove its child: neither uncommitted files nor an unproven merge refuses deletion. A working child must
finish or be stopped first. A worktree folder that is already gone (#715) holds no work to lose, so deletion
goes ahead without a snapshot: the session goes to the archive, `git worktree prune` drops git's stale entry, and
the branch is kept when it has commits the trunk lacks (or when that cannot be told) or when another
worktree has it checked out, and removed when it has none. "Gone" means `lstat` failed with ENOENT and the folder
above it is there; any other error, or a missing parent (a volume not mounted), is refused with "Cannot reach the
worktree folder" and nothing is removed. The note says git's entry was pruned only when `git worktree list` no
longer shows it. The answer carries a `note` saying so in one line. A merge run as `gh pr merge --delete-branch` beside a
worktree removes that folder this way (gh deletes the local branch, so it removes the worktree that holds it),
which is why the project board's merge queue deletes the branch on GitHub only. The session never
becomes a same-folder deletion: it keeps its worktree metadata. Cleanup refuses a child still waking/restarting, blocks sends/resumes, and requires
successful disposal of the idle CLI before snapshotting. It is also refused while any other session has its
folder inside the worktree (#647), asleep or not: a helper the child started without a worktree of its own
works there, and after a host swap no session has a process, so a message would wake it right in the folder.
The answer names those sessions so the parent deletes them first. While a cleanup runs, every session whose
folder is inside that worktree is held like the child itself (no send, wake, resume or fork), and the
occupants are checked again after the snapshot and again after archiving: one that came in meanwhile (restored
from the archive, opened there) keeps the worktree in place, with the snapshot kept. A sidebar delete already
under way refuses it too, and a cleanup cannot join a delete that started first: that delete's archive record
carries no recovery snapshot, so the worktree stays in place for that path. Failed capture leaves the worktree and branch in place. Once captured,
the session goes to the archive, then the worktree (including initialized submodules) and branch are removed.
After archiving, removal errors return `deleted` with a warning naming the leftover worktree/branch and
recovery location. The parent cannot retry an archived session through `agent_session`. Capture errors still
return a refusal before archiving. The
tool's conversation remains. The answer reports the uncommitted file and commit counts, or that nothing
needed setting aside. A saved notice also offers the recovery directory in the archived conversation. Counts
count the union of HEAD and the stored branch against the configured local trunk (project HEAD if unset),
not a GitHub merge badge; squash/rebase commits may therefore be kept conservatively. An unreadable trunk
keeps all reachable commits. Submodules count local HEAD/branch commits and gitlink targets from the
index, HEAD tree, and every unmerged superproject commit against their remote refs. The configured trunk's
history is scanned too (#623), when the project has modules: a gitlink merged there still names a module
commit that may exist only in this checkout's private repository, so a commit that no remote has is kept even
though the superproject history that records it landed. Candidate gitlinks
are batch-checked in each module repository; unfetched objects are skipped because removing this
checkout cannot lose them. Existence checks set `GIT_NO_LAZY_FETCH=1` and disable transports with
`GIT_ALLOW_PROTOCOL=`; the latter also prevents network access on Git versions that predate the lazy-fetch
switch. A single raw log scan and one HEAD tree listing stream to temporary files,
so history length does not require one process per commit or fit in the stdout buffer. Historical
`.gitmodules` names associate renamed paths with their initialized module; each distinct manifest is read
once. Capture includes intermediate commits and the stored branch even after the submodule HEAD moves away. Gitlink-only targets get
temporary named refs in the bundle so they remain fetchable after the private module repository is removed;
the temporary refs are removed from the live repository after bundling. Revision lists, bundle refs, and
temporary ref updates use stdin, keeping large module histories below Windows command-line limits.
The raw log explicitly uses `--diff-merges=separate`, independent of the person's `log.diffMerges` setting.

**Git compatibility.** This repository does not otherwise pin a minimum Git version. Recovery capture
requires Git 2.31 or newer: that release introduced both `--diff-merges` and `bundle --stdin`
([upstream release notes](https://raw.githubusercontent.com/git/git/v2.31.0/Documentation/RelNotes/2.31.0.txt)).
Older Git fails capture before deletion; upgrade Git to use recovery. The lazy-fetch switch arrived in
[Git 2.45](https://raw.githubusercontent.com/git/git/v2.45.0/Documentation/RelNotes/2.45.0.txt);
on 2.31–2.44 the empty protocol allowlist still prevents existence checks from reaching a remote.

The archive record's optional `recovery` JSON field remembers the snapshot id, tip and counts; this is additive and
needs no schema migration. Files live at `<data>/worktree-recovery/<session id>/<snapshot id>/`:
`0.patch` holds the root's working changes from HEAD, `0.staged.patch` its staged changes, `0.bundle` a
self-contained bundle of both HEAD and the stored branch when commits are absent from the trunk, and
`snapshot.json` the tip, repository map and exported refs. Initialized submodules use subsequent numbers, recursively. Binary files and symlink
targets are preserved; ignored untracked files are excluded. A private temporary index captures the
working tree without changing its real index; hooks and filters are disabled to keep the bytes on disk.
Git writes patches directly with `diff --output`, preserving CP949/Latin-1 text bytes without a stdout buffer
limit. Before any `git add`, a preflight refuses input above 256 MiB across all initialized repositories
(tracked and non-ignored untracked working files plus changed staged blobs). It leaves the files and index
untouched. Add/diff allow 120 seconds. The index is removed after capture. Clean, merged work creates only the small restore metadata, no patch
or bundle. Archive byte totals include recovery files.

Restore recreates the root branch/worktree at its saved tip and attempts both patches before making the
session live (its CLI remains stopped). If the original branch name is occupied, it uses `recovered/<session id>`.
An occupied original name is left alone, whoever made it. A recovery name is taken over when it is free, or
when restore made it (#647): `git worktree add -b` creates the branch before the folder, so a failed attempt
leaves the branch behind, and a retry reuses that leftover instead of failing on it. The mark is a ref under
`refs/centralu/recovered/<branch>` at the saved tip; restore creates the mark and the branch together, both
with the same one-time reflog message, and adopts a branch only when its creation entry matches the mark's.
A branch the person deletes and makes again at the same commit has a new reflog, so it is never adopted and
a numeric suffix is used instead: a later cleanup never deletes a branch the person made. A cleanup that
deletes a recovery branch deletes its mark too, so saved commits do not stay reachable for good.
If HEAD and the bundled stored branch differ, restore also creates `recovered/<session id>-stored-branch`
at the stored tip and names it in the notice. An occupied recovery name gets a numeric suffix; a retry
reuses a branch already at that tip. Existing branches are never overwritten.
A notice offers the recovery paths and `git apply` / `git fetch <bundle> <ref>:<branch>` (`git bundle list-heads` lists saved refs) instructions; patches
that cannot be applied and all submodule recovery remain available for manual recovery. A restore interrupted
after creating the worktree does not reapply patches on retry, to preserve possible edits since the interruption.
A `patches-applied` marker records the worktree path after both patches succeed. On retry the notice
reports that prior success, preserving any subsequent edits. Without that marker it explicitly says
patches were not applied on this retry and may need manual recovery. Recreating a missing worktree
clears the old marker before applying patches again. Each later deletion uses a new snapshot so earlier
files are retained. Deleting for good, including delete all archived sessions, removes the entire session recovery directory
only after the rows are gone (#647): the directory is first moved aside, which fails where removal would and
leaves the archive entry retryable, then deleted once the database step succeeds, or moved back when that step
fails, so the entry stays restorable. A folder that cannot be moved back is logged and left aside under
`<session id>.purging-<random>`; at startup such folders go back under their session's
name while the entry is still in the archive (joining any snapshot made since), and are deleted once it is gone,
so a crash at any point of a purge is repaired. Purge and restore wait for that repair; a folder that cannot
be repaired (held open on Windows) is logged and retried at the next start, and the others go on. No automatic archive expiry is implemented; expiry
must use `purgeSession` if added. A superproject merge does not prove that module commits were pushed, so
gitlinks in merged trunk history are scanned like unmerged ones (#623). Writes by other programs during capture are outside this session's lock.
