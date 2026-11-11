# macOS permissions and the shell

**TC1. Whatever holds permissions keeps the same bytes.**
Happened: an ad-hoc signature's designated requirement is the cdhash, so every update and local build was a new app
and lost Screen Recording, Accessibility and folder grants (#220).
Rule: the shell is built once per shell version and pinned in `packaging/shell/shell.lock` (version, sha256, cdhash);
releases download it; a hash mismatch fails; the icon and usage descriptions are part of the pinned bytes.
Guard: `tooling/shell-bundle.test.ts` "a download whose sha256 is not the pinned one is refused and not written";
`tooling/shell-bundle.test.ts` "one shell version in src/lib.rs, Info.plist and its bundle version".
Platforms: macOS.

**TC2. macOS judges a process by the app that started its tree.**
Happened: measured on macOS 27 (spikes/2026-10-thin-shell-tcc.md, #440, #443): grants follow the responsible process
through content replacement, a keeper handoff and the shell's exit; a child of the window is judged as the window.
Rule: the grant holder is started by LaunchServices (`open -n -g -a <shell> --args …`), never as the window's child.
Guard: `window/shell/start/tests.rs` `opens_through_launch_services_without_activating` (the command only); the
permission behaviour is *Manual*, the spike's probe before each shell version: **UNGUARDED** in CI. Unmeasured: the
responsible process of a keeper started by a keeper, and of a window relaunched by Tauri.
Platforms: macOS.

**TC3. A shell nested in the window's bundle loses Screen Recording.**
Happened: nested in `Contents/Helpers`, Accessibility stayed but Screen Recording followed the outer bundle, so a window
update lost it (#440).
Rule: the shell lives at `<data>/shell/Centralu.app`; the window carries its bytes only as a copy source.
Guard: *Manual* (thin-shell.md §10.2 "Checked by hand"): **UNGUARDED** in CI.
Platforms: macOS.

**TC4. Quarantine and extended attributes do not follow the shell.**
Rule: the window copies file bytes and mode bits only: no extended attributes, no symlinks; the tree hash refuses
symlinks.
Guard: `window/shell/install/tests.rs` `the_tree_hash_is_the_one_the_release_staging_writes`. Not copying extended
attributes is **UNGUARDED**.
Platforms: macOS.

**TC5. A process LaunchServices started reports to nobody.**
Happened: the shell's exit code and stderr reach no one (thin-shell.md §10.1).
Rule: the shell reports in `<data>/shell-status.json`, replaced whole by rename, `0600`, `O_NOFOLLOW`, carrying the
window's nonce; a report with another nonce is not this start's; a refused command line still reports to the folder it
names, without creating it.
Guard: `shell/status.rs` `the_file_is_replaced_whole_and_private`; `window/shell/start/tests.rs`
`a_report_from_another_start_is_not_this_ones`; `shell/args.rs` `a_refused_command_line_still_names_where_to_report`;
`scripts/shell-integration.mts` check "the status carries the nonce the window passed".
Platforms: macOS.

**TC6. The window's wait for the shell is bounded.**
Rule: up to 45 s for the report (the shell waits 25 s for its keeper); a keeper that answers without a report counts as
started after 3 s; `open` failing falls back at once; `open` itself is bounded at 15 s.
Guard: `window/shell/start/tests.rs` `a_keeper_that_answers_without_a_report_counts_as_started_after_a_grace`;
`window/shell/start/tests.rs` `launch_services_failing_falls_back_at_once`; `window/shell/tests.rs`
`a_shell_that_never_reports_falls_back_visibly`. The 15 s bound on `open` is **UNGUARDED**.
Platforms: macOS.

**TC7. A keeper already answering means nothing else happens.**
Rule: the window opens no shell; a shell that finds one answering verifies, copies and starts nothing; a keeper that
exits "already running" while another answers counts as ready.
Guard: `window/shell/tests.rs` `a_keeper_answering_installs_and_opens_nothing`; `shell/run/tests.rs`
`a_keeper_already_answering_means_nothing_is_verified_copied_or_started`. The exit-3 race is **UNGUARDED**.
Platforms: macOS.

**TC8. A keeper the shell started that never answers is killed.**
Rule: so the window's fallback start is not stuck waiting on the lock.
Guard: `shell/run/tests.rs` `a_keeper_that_cannot_start_exits_or_never_answers_is_refused`.
Platforms: macOS.

**TC9. An unpinned shell is neither installed nor opened.**
Happened: opening a local build's shell costs a launch, and a build under `~/Desktop` asks for folder access in the
shell's name; installing it would put unpinned bytes where permissions attach.
Rule: log the reason and start the keeper directly; `CC_SHELL_UNPINNED=1` opens it by hand with a temporary data folder.
Guard: `window/shell/tests.rs` `a_local_build_does_not_install_or_open_its_unpinned_shell_and_only_logs_why`.
Platforms: macOS.

**TC10. Installing a shell never leaves none, and never goes down.**
Rule: never replace a higher installed version; at the same version replace only pinned over different bytes; copy to
`.new`, hash it, rename the old one aside, rename the new one in, rename back on failure; remove the old one only after
the new shell started a keeper; put the old one back when a window stopped between the renames.
Guard: `window/shell/install/tests.rs` `the_decision_table`; `window/shell/install/tests.rs`
`a_failure_at_any_step_leaves_the_installed_shell_in_place`; `window/shell/install/tests.rs`
`a_window_that_stopped_between_the_renames_gets_the_old_shell_back`; `window/shell/tests.rs`
`an_upgrade_removes_the_old_shell_only_after_the_new_one_started_a_keeper`.
Platforms: macOS.

**TC11. The shell's zip is reproducible.**
Happened: a file created under `/tmp` takes group `wheel` instead of `staff`, and that alone changed the hash.
Rule: set uid, gid and a fixed time on every file, then `ditto --norsrc --noextattr --noqtn --noacl`.
Guard: `tooling/shell-release-workflow.test.ts` "zips reproducibly: the same bundle zipped twice must give the same sha256".
Platforms: macOS.

**TC12. The shell links nothing graphical and needs no run loop.**
Happened: "Not responding" is the window server's verdict on a connected process that does not handle its events
(Apple DTS, thin-shell.md §3).
Rule: link only `libSystem` and `libiconv`; `LSUIElement`, so one Dock icon, the window's.
Guard: `scripts/shell-integration.mts` check "links libSystem and libiconv only: no AppKit, CoreGraphics or SkyLight, so no window
server connection".
Platforms: macOS.

**TC13. A missing usage description ends the process that asks.**
Rule: the shell declares every privacy class up front; adding one later is a new shell version.
Guard: `tooling/shell-bundle.test.ts` "declares a usage description for every privacy class that would otherwise end the
asking process".
Platforms: macOS.

**TC14. The shell never creates or migrates the data folder.**
Happened: migration rules in pinned bytes could never change.
Guard: `shell/run/tests.rs` `a_data_folder_that_does_not_exist_is_refused_and_not_created`.
Platforms: macOS.

**TC15. One shell fallback lasts for the window's life.**
Happened: retrying a slow failure would cost 45 s on every reconnect (thin-shell.md §10.2).
Rule: after a refusal or no report, the window starts keepers directly until it quits, with the reason in the build bar
when the shell is pinned.
Guard: `window/shell/tests.rs` `each_refusal_starts_the_keeper_directly_with_the_shells_reason_shown_in_a_release`
(one start); that it sticks across later starts (`KeeperLink`) is **UNGUARDED**.
Platforms: macOS.

**TC17. A tool started under Centralu asks in Centralu's name.**
Happened: the default trash goes through Finder by AppleScript, which raises an automation prompt and, if declined,
silently deletes nothing (5b05f2b3).
Rule: use APIs that need no new grant (`NSFileManager` for trash); never trigger a permission prompt by a side path.
Guard: **UNGUARDED**.
Platforms: macOS.
