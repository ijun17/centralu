//! The Centralu desktop shell.
//!
//! There are only three jobs here: supervising the sidecar, OS integration (notifications,
//! the badge, shortcuts, opening the IDE) and window management. The conversation, state and
//! screens all live on the webview side (docs/architecture.md §4).

// The host supervisor and the keeper live in a crate of their own with no Tauri in it (#440), so
// the keeper executable (`src/bin/centralu-keeper.rs`) can link them without the webview.
use centralu_keeper_core::host_proc;
#[cfg(unix)]
pub use centralu_keeper_core::keeper;
mod app_links;
mod ide;
mod os_integration;
mod path_safety;
mod quit;
// The window's side of the macOS shell (thin-shell plan §6): only a macOS release build opens it.
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod shell;
mod sidecar;

// Globs, so `generate_handler!` below finds each command, and the macro Tauri writes beside it, by its name
use app_links::*;
use os_integration::*;
use quit::*;
use sidecar::{HostBuild, HostInfo, RelaunchInfo, Supervisor};

/// Whether this process was started as the keeper (`centralu --keeper`, #280). `main()` asks
/// before anything else, so keeper mode never builds the Tauri app. Since #440 the keeper is
/// `centralu-keeper`; this form is a debug window's keeper in its own executable, and anything else
/// is refused (#461).
pub fn is_keeper(args: &[String]) -> bool {
    #[cfg(unix)]
    {
        keeper::is_keeper_invocation(args)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        false
    }
}

/// Runs the keeper here for a debug window that asked (`CC_KEEPER_IN_PROCESS`), or refuses at once
/// (#461). Returns the exit code.
pub fn run_keeper(args: &[String]) -> i32 {
    #[cfg(unix)]
    {
        keeper::exe::run_from_window(args)
    }
    #[cfg(not(unix))]
    {
        let _ = args;
        eprintln!("the keeper needs a unix socket and is not available on this platform");
        2
    }
}
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[tauri::command]
fn host_info(sup: State<'_, Supervisor>) -> Option<HostInfo> {
    sup.info()
}

#[tauri::command]
fn host_error(sup: State<'_, Supervisor>) -> Option<String> {
    sup.last_error()
}

/// Which builds are involved (#280): this window's, the running host's, and whether they are
/// the same one. `mode` is `keeper` or `direct`.
#[tauri::command]
fn host_build(sup: State<'_, Supervisor>) -> HostBuild {
    sup.build()
}

/**
 * Runs `work`, which waits on the keeper's socket (up to 10 s), on Tauri's pool for blocking work
 * (#840 item 6). A plain command runs on the main thread, so while the keeper was slow to answer
 * the whole window hung with the spinning cursor; `#[tauri::command(async)]` would only move the
 * wait onto one of the async runtime's few workers.
 */
async fn off_main_thread<T: Send + 'static>(app: AppHandle, work: impl FnOnce(AppHandle) -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(app)).await.map_err(|e| format!("the request to the keeper did not finish: {e}"))
}

/// Switches the host to this window's build with the keeper's blue-green swap (#280 step 3). The
/// swap's progress reaches the UI in `host-build`.
#[tauri::command]
async fn switch_host_build(app: AppHandle) -> Result<(), String> {
    off_main_thread(app, |app| app.state::<Supervisor>().switch_build()).await?
}

/// Background mode (#280): whether quitting leaves the agents running. Off by default.
#[tauri::command]
async fn background_mode(app: AppHandle) -> Result<bool, String> {
    off_main_thread(app, |app| app.state::<Supervisor>().background()).await?
}

#[tauri::command]
async fn set_background_mode(app: AppHandle, on: bool) -> Result<bool, String> {
    off_main_thread(app, move |app| app.state::<Supervisor>().set_background(on)).await?
}

/// "Quit completely" (#280): stops the keeper, the host and everything they hold (agents,
/// terminals, running commands) whatever background mode says, then quits.
#[tauri::command]
async fn quit_and_stop_agents(app: AppHandle) -> Result<(), String> {
    off_main_thread(app, |app| {
        app.state::<Supervisor>().stop_agents()?;
        app.state::<QuitApproved>().0.store(true, std::sync::atomic::Ordering::SeqCst);
        app.exit(0);
        Ok(())
    })
    .await?
}

/// "Restart completely" (#387): stops the keeper and everything it holds, and this window starts a
/// keeper of its own build. For a keeper that could not hand itself over to this build.
#[tauri::command]
async fn restart_keeper(app: AppHandle) -> Result<(), String> {
    off_main_thread(app, |app| app.state::<Supervisor>().restart_keeper()).await?
}

/// Whether "Apply now" can relaunch this window into the update just installed (#352).
#[tauri::command]
fn relaunch_info(sup: State<'_, Supervisor>) -> RelaunchInfo {
    sup.relaunch_info()
}

/**
 * "Apply now" (#352): relaunches the app from its bundle, which `centralu install` has just
 * replaced, so the new window is the new build.
 *
 * The keeper is told first, so the window closing is not "the last window left" even with
 * background mode off; the new window attaches within the keeper's grace and is told it is the
 * relaunched one, then applies the switch (keeper, then host) by itself when nothing can be lost.
 * A keeper too old to hold on is acceptable only with background mode on, where a window closing
 * never stopped anything; with it off this refuses, rather than cutting every turn.
 *
 * `request_restart`, not `restart`: `restart` skips the exit events and so the detach below (it
 * showed when this ran on the main thread; it runs off it now, #840 item 6). Through
 * `ExitRequested` with a code (our quit gate lets a programmatic exit through) and `Exit`, Tauri
 * then runs this executable's path again, reading the executable's name from the bundle's new
 * `Info.plist` (`tauri::process::restart`, 2.11.5).
 */
#[tauri::command]
async fn apply_update_relaunch(app: AppHandle) -> Result<(), String> {
    off_main_thread(app, |app| {
        let sup = app.state::<Supervisor>();
        let info = sup.relaunch_info();
        if !info.ready {
            return Err(info.reason.unwrap_or_else(|| "relaunching would not start the new version".into()));
        }
        if let Err(e) = sup.announce_relaunch() {
            if sup.background() != Ok(true) {
                return Err(format!(
                    "Not relaunched: {e}. With background mode off the running agents would stop; quit and open Centralu again when they are done."
                ));
            }
        }
        app.state::<QuitApproved>().0.store(true, std::sync::atomic::Ordering::SeqCst);
        app.request_restart();
        Ok(())
    })
    .await?
}

/// Retry from the failure screen (#184). Restarts a supervisor that has given up — merely
/// reloading the webview does not bring the host back up. Does nothing if it is still running
/// (an answer is coming soon anyway).
#[tauri::command]
async fn restart_host(app: AppHandle) -> bool {
    off_main_thread(app, |app| app.state::<Supervisor>().restart(app.clone())).await.unwrap_or(false)
}

/**
 * Where this process should work from instead of `cwd`, or None to stay.
 *
 * Windows holds a process's working directory open, and while any process has its working
 * directory inside the app's folder, that folder cannot be renamed. Renaming it aside is how
 * `centralu install` replaces the copy in `%LOCALAPPDATA%\Programs\Centralu` while the app runs
 * (an in-app update): measured on Windows 11 on 2026-10-08, the rename succeeds with the exe and
 * the host's native modules mapped and fails only when a working directory is inside. The launcher
 * and the Start-menu shortcut start the app in the home folder, but File Explorer starts an exe in
 * its own folder, and the host inherits it. So the app leaves its own folder before it starts the
 * host. A working directory anywhere else is the person's choice and is kept.
 */
#[cfg_attr(not(target_os = "windows"), allow(dead_code))] // called on Windows only; tested everywhere
fn working_dir_away_from(cwd: &std::path::Path, exe_dir: &std::path::Path, home: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    if cwd.starts_with(exe_dir) {
        home
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn leave_app_folder() {
    let (Ok(cwd), Ok(exe)) = (std::env::current_dir(), std::env::current_exe()) else { return };
    let Some(exe_dir) = exe.parent() else { return };
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    if let Some(to) = working_dir_away_from(&cwd, exe_dir, home) {
        if let Err(e) = std::env::set_current_dir(&to) {
            eprintln!("[startup] could not leave the app folder for {}: {e}", to.display());
        }
    }
}

/**
 * #840 item 6: a command that waits on the keeper's socket runs that wait off the main thread, on
 * the blocking pool (`off_main_thread`). A plain command runs on the main thread, so while the
 * keeper was slow to answer (up to 10 s for a switch) the whole window hung.
 */
#[cfg(test)]
mod keeper_command_tests {
    /// The `Supervisor` calls that send a request to the keeper and wait for its answer.
    const WAITS_ON_KEEPER: [&str; 7] =
        [".switch_build(", ".background(", ".set_background(", ".stop_agents(", ".restart_keeper(", ".announce_relaunch(", ".restart("];

    #[test]
    fn a_command_that_waits_on_the_keeper_runs_off_the_main_thread() {
        let src = include_str!("lib.rs");
        // The commands, not this test
        let commands = src.split("#[cfg(test)]").next().unwrap();
        let mut checked = 0;
        for chunk in commands.split("#[tauri::command").skip(1) {
            let body = &chunk[..chunk.find("\n}\n").unwrap_or(chunk.len())];
            let name = body.split_once("fn ").and_then(|(_, r)| r.split_once('(')).map(|(n, _)| n).unwrap_or("?");
            if WAITS_ON_KEEPER.iter().any(|c| body.contains(c)) {
                checked += 1;
                assert!(body.contains("async fn ") && body.contains("off_main_thread("), "the command `{name}` waits on the keeper on the main thread");
            }
        }
        assert!(checked >= 7, "only {checked} commands that wait on the keeper were found");
    }
}

#[cfg(test)]
mod working_dir_tests {
    use super::working_dir_away_from;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_working_directory_inside_the_app_folder_moves_home() {
        let home = Some(PathBuf::from("/home/me"));
        assert_eq!(working_dir_away_from(Path::new("/apps/Centralu"), Path::new("/apps/Centralu"), home.clone()), home);
        assert_eq!(
            working_dir_away_from(Path::new("/apps/Centralu/resources"), Path::new("/apps/Centralu"), home.clone()),
            home
        );
    }

    #[test]
    fn any_other_working_directory_is_kept() {
        let home = Some(PathBuf::from("/home/me"));
        assert_eq!(working_dir_away_from(Path::new("/home/me/project"), Path::new("/apps/Centralu"), home.clone()), None);
        // A sibling whose name starts the same is not inside
        assert_eq!(working_dir_away_from(Path::new("/apps/Centralu.old-1"), Path::new("/apps/Centralu"), home), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(target_os = "macos")]
mod traffic_lights;

pub fn run() {
    // Before anything is started from here: the host inherits the working directory
    #[cfg(target_os = "windows")]
    leave_app_folder();
    let supervisor = Supervisor::new();
    let quit_approved = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(supervisor.clone())
        .manage(QuitApproved(quit_approved.clone()))
        .manage(AppLinks::default())
        // Adding a command means also adding it to the list in build.rs and to the
        // `allow-<command>` permission in capabilities/default.json. A command with no
        // permission is refused even from the main window (#143).
        .invoke_handler(tauri::generate_handler![
            host_info,
            host_error,
            restart_host,
            set_badge,
            alert,
            open_in_ide,
            reveal_path,
            trash_path,
            file_manager_name,
            focus_window,
            window_controls_inset,
            shortcut_keys,
            quit_app,
            take_app_links,
            host_build,
            switch_host_build,
            background_mode,
            set_background_mode,
            quit_and_stop_agents,
            restart_keeper,
            relaunch_info,
            apply_update_relaunch
        ])
        /*
         * ⌘W and the red button both mean closing the window. Since this app has only one
         * window, closing it means quitting — so instead of closing immediately, it asks the
         * webview (dogfooding: one mistyped ⌘W during work took down an entire session).
         */
        /* Our own Quit item — sends the same message as closing the window (the modal is put
         * up by the webview). */
        .on_menu_event(|app, event| {
            if event.id() == "cc-quit" {
                let _ = app.emit("quit-requested", ());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
        })
        .setup({
            let sup = supervisor.clone();
            move |app| {
                sup.start(app.handle().clone());
                #[cfg(target_os = "macos")]
                traffic_lights::install(app.handle());
                #[cfg(target_os = "macos")]
                if let Err(e) = install_quit_menu(app.handle()) {
                    // The app still launches even if the menu could not be changed — ⌘Q just
                    // quits immediately again, as it used to.
                    eprintln!("[menu] could not install the quit item: {e}");
                }
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri app")
        .run(move |app, event| {
            // App links (M4 E-4) — a `centralu://` link handed over by the OS. This is also
            // where things land when the app is first launched by such a link.
            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                receive_app_links(app, urls.iter().map(|u| u.as_str()));
                return;
            }
            /*
             * The exit gate (dogfooding, 2026-09-04). Until the person confirms in the modal,
             * exit is blocked and the webview is asked instead — only `quit_app` sets the
             * flag, so any ExitRequested that arrives after that passes straight through.
             *
             * **⌘Q never reaches here** (not measured, confirmed against upstream source on
             * 2026-09-07): macOS's terminate has no place to hang a veto, so this event
             * simply never fires for it. That case is caught earlier by `install_quit_menu` in
             * the menu — what this gate is responsible for is the last-window-closed case and
             * the exit we call ourselves.
             *
             * `code` is a documented distinction: `None` means a user interaction (⌘Q, the
             * dock's Quit, logout), and `Some` means a programmatic exit
             * (`AppHandle::exit`/restart — the updater's restart travels this path). Blocking
             * `Some` too would mean the app blocking its own restart.
             */
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() && !quit_approved.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("quit-requested", ());
                    return;
                }
            }
            // Direct mode: make sure the sidecar is killed when the app closes (no zombie
            // processes). Keeper mode: detach; the keeper applies background mode.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                supervisor.shutdown();
                let _ = app.emit("host-status", "shutdown");
            }
        });
}
