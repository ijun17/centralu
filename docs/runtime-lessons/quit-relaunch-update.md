# Quit, relaunch and update

**UP1. ⌘Q cannot be vetoed where Tauri reports it.**
Happened: tao implements no `applicationShouldTerminate:`, and wry emits `ExitRequested` only after the last window is
destroyed (read in the upstream source, 1eee9563).
Rule: replace the predefined Quit item with one that asks the webview; Dock Quit and logout still terminate at once (a
known gap).
Guard: `platform/tauri/startup.test.ts` "quits right away if there is nothing to ask (the startup or startup-failure
screen), and hands off to it if something is up". The Rust side is **UNGUARDED**.
Platforms: macOS.

**UP2. The exit gate.**
Happened: one mistyped ⌘W during work took down a whole session.
Rule: `CloseRequested` is prevented and asked; an `ExitRequested` without a code and without approval is blocked; one
with a code always passes (the updater's restart and our own exits); the approval flag is set before `exit()`.
Guard: **UNGUARDED**.
Platforms: all.

**UP3. Under a keeper, quitting only detaches.**
Rule: the window never stops the host or waits on it; background mode and the reattach grace are the keeper's; in
direct mode the window kills its host on exit.
Guard: `window/sidecar/mod.rs` `a_supervisor_that_never_started_reports_direct_mode` (direct mode); detach is **UNGUARDED**.
Platforms: all.

**UP4. "Apply now" only when a relaunch starts a different build.**
Happened: under `pnpm app:open` the window runs the build output, which the update does not touch; a half-replaced
bundle could start nothing (#352, 7c226b70).
Rule: offered only when the window is in a bundle, the build on disk is readable and differs; never in direct mode,
where the host is the window's child; never from a window already on the installed version; once per window.
Guard: `window/sidecar/relaunch.rs` `apply_now_relaunches_only_into_a_different_build_on_disk`;
`packages/ui/src/features/settings/apply-update.test.ts` "does not loop: not from the relaunched window, not twice from
one window, not where a relaunch changes nothing".
Platforms: macOS, Linux.

**UP5. The relaunch is `request_restart` of the same path.**
Happened: a command runs on the main thread, where `restart` skips the exit events and with them the detach;
`centralu install` replaced the bundle, so the same path names the new executable (tauri 2.11.5).
Rule: set the approval, then `request_restart`.
Guard: **UNGUARDED**.
Platforms: macOS.

**UP6. The keeper is told before the window goes.**
Happened: with background mode off (the default), the old window closing was "the last window" and stopped
everything (#352). Announcing the relaunch (`relaunching`, a grace of up to 300 s) kept the keeper for the new window,
which then switched it; #1895 step 4 PR 3 replaced both with the stop below.
Rule: "Apply now" sends `stop {forUpdate}` and relaunches only once the keeper answered; it is offered only by a keeper
whose view says `stopsForUpdate`, and any other keeper is restarted from the build bar first; a refused stop keeps the
window attached and says why.
Guard: `window/sidecar/link.rs` `apply_now_is_offered_only_with_a_keeper_that_stops_for_an_update`;
`window/sidecar/link.rs` `apply_now_refused_by_the_keeper_does_not_relaunch_even_with_background_mode_on`;
`window/sidecar/link.rs` `a_refused_stop_for_an_update_keeps_the_window_attached_and_says_why`.
Platforms: macOS, Linux.

**UP7. A window restarts a keeper of another build by itself only forward, and only when nothing is lost.**
Happened: opening an older window with the automatic mode on quietly downgraded keeper and host (#421, 5c5f60a3).
Rule: newer means a higher app version, then a later build time; what cannot be ordered is never newer; restart by
itself only with automatic updates on, when the keeper reports itself idle (`busy === false`) and can stop for an update,
once per window and not after the bar was dismissed; the button asks first unless the keeper reports itself idle, and
always before a plain stop (a keeper whose host is down reports idle).
Guard: `platform/tauri/switch-plan.test.ts` "only forward: a window of an older build never restarts by itself";
`platform/tauri/switch-plan.test.ts` "what cannot be ordered is never newer, either way";
`platform/tauri/switch-plan.test.ts` "never a plain stop: a keeper that cannot stop for an update, or does not say, is left
to the button"; `platform/tauri/switch-plan.test.ts` "a plain stop always asks, even from a keeper that reports itself
idle"; `platform/tauri/switch-plan.test.ts` "never while something runs or nobody knows, never with the setting off, never
twice, never after "Not now""; `e2e/relaunch.spec.ts` "with something running, the restart asks first, says the
turns go on, and nothing restarts by itself";
`packages/ui/src/features/settings/apply-update.test.ts` "never applies while anything is running, and unknown counts
as running".
Platforms: macOS, Linux.

**UP8. "Restart completely" replaces a keeper that cannot move.**
Rule: it is the keeper's `stop`; the window stays, sees the keeper exit and starts one of its own build. The build bar's
"Restart into this build" (#1895 step 4 PR 3) is the same, with `stop {forUpdate}` to a keeper that can stop for an
update (`window/sidecar/link.rs` `a_restart_into_this_build_stops_the_keeper_for_an_update_when_it_can`).
Guard: **UNGUARDED** in Rust (the window's attach loop); covered in `e2e/quit-dialog.spec.ts` for the dialog only.
Platforms: macOS, Linux.

**UP9. A switch names the keeper inside the bundle, never a copy.**
Rule: `switch` carries `keeper.exe` as the `centralu-keeper` beside the window's executable (none in debug); an older
keeper ignores the field and swaps only the host. No window of this build sends `switch` since #1895 step 4 PR 3; the
rule stands for an earlier build's window until the keeper's `switch` goes (PR 4).
Guard: none left on the window side.
Platforms: macOS, Linux.

**UP10. The code that runs an update is the old code.**
Happened: the launcher's semver compared prereleases as NaN (#42); the `/Applications` copy went stale (#52, a91df081);
the old keeper's handoff bug (#391); the old window's Windows updater (#456). Each time the fix shipped in a build the
broken one had to install first.
Rule: every update path has a manual escape that does not depend on the installed code; the window says when its copy
differs from the package.
Guard: `tooling/launcher-semver.test.ts` "sees the next prerelease (the exact failure that shipped)";
`tooling/launcher-semver.test.ts` "speaks up on the drift that actually happened".
Platforms: all.

**UP11. The npm launcher on Windows runs npm through the shell and refuses what it would interpret.**
Rule: the launcher's own `npm` call goes through the shell because npm is `npm.cmd` there, and refuses any argument the
shell would read as syntax; the host never does this (PA9, PA10).
Guard: `tooling/launcher-platform.test.ts` "runs npm through the shell, since npm is npm.cmd there";
`tooling/launcher-platform.test.ts` "refuses an argument the shell would interpret".
Platforms: Windows.
