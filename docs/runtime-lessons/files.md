# Files a running process depends on

**FI1. A host never runs from files an update rewrites.**
Happened: a host running from the bundle read the Codex bridge, `schema.sql` and `app-template/` on demand and mixed two
builds (2026-10-03).
Rule: run from a per-build copy (`<data>/hosts/<key>`) or a verified `<data>/content/<version>/host`; copy through a
temporary folder and a rename, keep the executable bit (node-pty's spawn-helper: `posix_spawnp failed`); a dirty or
unknown commit gets its build time in the key.
Guard: `keeper/keeper/source.rs` `the_copy_survives_the_bundle_being_rewritten_and_keeps_the_exec_bit`;
`keeper/keeper/source.rs` `a_complete_copy_is_reused_and_a_half_one_is_replaced`; `keeper/keeper/source.rs`
`a_dirty_or_unknown_build_is_told_apart_by_its_build_time`.
Platforms: macOS, Linux.

**FI2. Copies and cleanups go through one lock.**
Happened: after a handoff, the cleanup set off by the adopted host's ready line deleted the copy a switch had just
renamed into place: "Cannot find module …/hosts/handoff-C/main.mjs" (#368, fixed by #441, 573be1e9; #325 had covered
only `.tmp-*`).
Rule: every copy and cleanup takes `source::Copies`; a claim holds a copy until a host runs from it; the cleanup reads
what is in use (the running host's folder and the next launch's) when it runs; temporary copies younger than 10 minutes
are left alone. The swap's claims and the freeze went with #1895 step 4 PR 4; the launch's claim stays.
Guard: `keeper/keeper/source.rs` `a_claimed_copy_survives_the_cleanup_a_ready_host_sets_off`;
`keeper/keeper/source.rs` `a_claimed_copy_is_never_taken_by_a_concurrent_cleanup`; `keeper/keeper/source.rs`
`the_cleanup_keeps_the_copy_the_host_runs_from_when_it_runs`; `keeper/keeper/server/tests.rs`
`the_folders_in_use_are_the_running_and_the_next`.
Platforms: macOS, Linux.

**FI3. A complete copy outlives the folder it came from.**
Happened: after a switch to a newer AppImage's build, the build's host folder lived in a mount that went away when that
window quit; `copy_into` checked the source before its own complete copy, so every later host restart failed and the
keeper gave up (measured in WSL, #458).
Rule: a complete copy is used first; the source is read only to make one.
Guard: `keeper/keeper/source.rs` `a_complete_copy_outlives_the_folder_it_came_from`.
Platforms: Linux. *Changed by #458.*

**FI4. Nothing long-lived runs from an AppImage mount.**
Happened: the type-2 runtime keeps the squashfs mounted while any process holds its keep-alive pipe or the mount's
descriptor; a keeper started by keeper A from a newer AppImage holds neither, so its mount went when that window quit,
and a debug keeper then died of SIGBUS when asked to stop, most likely at a page-in (#458, spikes/2026-10-linux-keeper.md
§6). The same holds for the host and every terminal.
Rule: the keeper and the host ran from plain, hashed, read-only files under `<data>/content/<version>/`, copied out
before a keeper started (`keeper/carried.rs`), and inherited descriptors were closed once nothing ran from the mount.
Removed: went with #1895 step 4 PR 7, which made Linux direct (ST15). What is left of the rule: nothing long-lived
outlives its window on Linux, since the window is the host's parent and the host runs from the mount only while the
window does.
Platforms: Linux. *Changed by runtime-unification step 4.*

**FI5. The AppImage's environment leaks into children.**
Happened: the AppRun sets GDK, GTK, `XDG_DATA_DIRS` and `APPDIR`, which reach terminals and agents (#14 audit).
Rule: a keeper from content dropped `APPDIR`, `APPIMAGE`, `ARGV0`, `OWD` and every `:`-separated entry inside the mount
before it started anything (`keeper/appimage.rs`).
Removed: went with #1895 step 4 PR 7 with the Linux keeper (ST15). The direct path, now Linux's only one, still passes
the variables on (work list row 56).
Platforms: Linux. *Changed by runtime-unification step 4.*

**FI6. The Linux host ships unpacked.**
Happened: the host inside the AppImage needs FUSE, which servers often lack (#390).
Rule: Linux packages carry `host/` beside the AppImage; a remote never runs the AppImage.
Guard: `tooling/launcher-serve.test.ts` "finds the bundled host in each platform package".
Platforms: Linux.

**FI7. Only signed content runs with the person's grants.**
Happened: running code from outside a signed bundle with the app's permissions needs a reason to trust it (#440,
#445, #448, #451).
Rule: verify the ed25519 signature over the manifest's exact bytes before parsing; read each file once from an
`O_NOFOLLOW` descriptor; copy into a fresh folder, hash the copy, make it read-only and run only the copy; reuse a copy
only if it verifies in place with the same manifest bytes; refuse a source inside `<data>/content`; never replace a
folder something runs from (`in-use`).
Since #1895 step 4 PR 4 only the shell copies; the keeper verifies nothing to run it, and the window reads its own
content again only to word the shell's refusal (`content::diagnose`). No caller asks `place` to leave an in-use folder
alone any more (the shell passes `in_use: false`); the option goes with the next shell version, since the verifier is
part of the shell's pinned bytes.
Guard: `shell/run/tests.rs` `content_that_is_not_what_was_signed_is_refused_and_nothing_runs`;
`keeper/keeper/content/tests.rs` `content_signed_with_a_key_this_build_does_not_trust_is_refused`;
`keeper/keeper/content/tests.rs` `content_from_inside_the_content_folder_is_refused`;
`keeper/keeper/content/tests.rs` `the_window_can_find_why_its_own_content_would_be_refused_without_running_or_copying_it`;
`apps/desktop/content-verify/tests/place.rs` `a_copy_that_no_longer_verifies_is_copied_again_unless_something_runs_from_it`;
`shell/run/tests.rs` `starts_the_keeper_from_the_verified_copy_with_the_windows_command_line`;
`shell/run/tests.rs` `a_second_start_of_the_same_version_uses_the_copy_once_it_verifies_again`.
Platforms: macOS (Linux and Windows to follow, plan step 4).

**FI8. A folder its owner cannot write cannot be renamed on macOS 14.**
Happened: #445 merged with CI red: macOS 14 refuses to rename a folder its owner cannot write, while macOS 27 (the
author's) refuses only across parents; fixed in #446 (879494f9).
Rule: rename the filled copy into place first, then `fchmod` it 0555 through a descriptor opened before the rename, then
list the top folder again and refuse anything unexpected.
Guard: `verify/copy.rs` `a_filled_copy_is_placed_and_then_made_read_only_in_any_parent`; `verify/copy.rs`
`something_added_to_the_top_folder_before_it_is_read_only_is_refused`.
Since 2026-11-02 these guards run in CI only on macOS 15 (GitHub retired the macOS 14 images), where the macOS 14
behavior may not reproduce, so they no longer prove this rule: a change to the copy needs a run on a macOS 14 machine.
Platforms: macOS.

**FI9. The downgrade floor rises only after a keeper served.**
Rule: `<data>/content/highest-started` is raised once the keeper answers (the shell) or serves (a handoff); a lower
version is refused unless the shell was asked for `--rollback`; an unreadable floor is logged and replaced, not a
refusal.
Guard: `shell/run/tests.rs` `an_older_version_than_one_that_ran_is_refused_unless_rolled_back_on_purpose`;
`shell/run/tests.rs` `an_unreadable_floor_does_not_stop_a_start`; `keeper/keeper/content/tests.rs`
`an_older_version_than_the_floor_is_refused_and_the_same_or_newer_is_not`.
Platforms: macOS.

**FI10. A test key cannot reach a release.**
Rule: the shell's extra key exists only behind its `test-key` feature, which is a `compile_error!` without
`debug_assertions`. The keeper has no test key at all since #1895 step 4 PR 4: nothing it runs is verified by it.
Guard: `shell/keys.rs` `a_build_without_the_test_feature_trusts_exactly_keys_json`; `keeper/keeper/keys.rs`
`the_keeper_trusts_exactly_keys_json`; `tooling/shell-bundle.test.ts` "a test key exists only
behind the test-key feature, which a release build refuses to compile"; `tooling/keeper-executable.test.ts` "trusts
packaging/shell/keys.json and no test key".
Platforms: macOS.

**FI11. On Windows a running program's files cannot be replaced.**
Happened: `npm i -g` hit EBUSY while the app ran from the package; Windows refuses to delete the last name of a running
program or to overwrite any of its names (#328, #353, #456).
Rule: run the app from a copy in `%LOCALAPPDATA%\Programs\Centralu`, install by assembling `.new` and swapping folders
by rename, keep the old one as `Centralu.old-*` until a later install sweeps it; the path the updater refreshes is the
launcher's.
Guard: `host/updates.test.ts` "is the path the launcher's install writes and its update refreshes, on every platform";
`tooling/launcher-platform.test.ts` "sweeps only the copies an earlier install renamed aside, nothing else in the shared
Programs folder"; `tooling/launcher-platform.test.ts` "names a running app as the reason Windows will not replace
files".
Platforms: Windows. *Changed by #456.*

**FI12. On Windows, Claude runs from Centralu's own link.**
Happened: the host started npm's `claude.exe`; an npm update could then neither delete nor overwrite it and left a
500-byte placeholder Windows calls a "16-bit program" (#353, c8020cee).
Rule: hard-link (or copy on EXDEV/EPERM) into `<data>\tools\claude\<version>-<size>\`, placed by rename; sweep links no
session uses; refuse a non-`MZ` `.exe` under 1 MB with the fix in the message.
Guard: `host/adapters/claude/exe-link.test.ts` "links npm's claude.exe under tools/claude/<version>-<size> and starts it
from there"; `host/adapters/claude/exe-link.test.ts` "a link Windows refuses to delete (a process still runs it) stays
for a later sweep, and the rest still go"; `host/adapters/claude/exe-link.test.ts` "is refused before a process starts,
naming the file and the fix".
Platforms: Windows.

**FI13. Native modules ship as files, not inside a single executable.**
Happened: Node SEA cannot embed better-sqlite3's `.node`, and injecting into a signed binary needs re-signing on macOS;
system Node was adopted and Bun compile put on hold (m2-f0-bundling.md "Decision (F-0a)").
Rule: native addons sit beside `main.mjs`; nothing is injected into a binary after signing; any Node 22.14 or later loads
the shipped modules (Node-API 10, measured on 24.21.0; 22.12.0 crashes, #699); remotes run a pinned Node.
Guard: `tooling/node-pin.test.ts` "is an exact 24.x release with a hash for every platform the installer serves";
`tooling/node-pin.test.ts` "CI runs the host’s tests on the pinned Node, on Linux and Windows, beside the jobs on 22".
Platforms: all. *Changed by #457.*
