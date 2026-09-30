//! The Centralu desktop shell.
//!
//! There are only three jobs here: supervising the sidecar, OS integration (notifications,
//! the badge, shortcuts, opening the IDE) and window management. The conversation, state and
//! screens all live on the webview side (docs/architecture.md §4).

mod ide;
mod path_safety;
mod sidecar;

use path_safety::assert_safe_native_path;
use sidecar::{HostInfo, Supervisor};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/**
 * Make ⌘Q ask too (dogfooding, 2026-09-07: "⌘W no longer quits immediately, but ⌘Q still
 * does").
 *
 * The ExitRequested gate in the run callback below **never sees ⌘Q.** The evidence is in the
 * upstream source:
 *   - tao's macOS app delegate does not implement `applicationShouldTerminate:`. It only has
 *     `applicationWillTerminate:`, which is a notification that arrives after termination has
 *     already been decided (tao 0.35.3 platform_impl/macos/app_delegate.rs).
 *   - The only place tauri-runtime-wry emits `ExitRequested{code:None}` is **after the last
 *     window has been Destroyed**; `Some(code)` only comes from `AppHandle::exit` (2.11.4
 *     lib.rs).
 *
 * So there is no place at all to hang a veto on ⌘Q (= NSApplication terminate). Instead we
 * make sure it never gets that far: the default menu's Quit item (a predefined item that
 * terminates immediately) is replaced with our own, and pressing it sends the webview the
 * **same message** as closing the window (quit-requested).
 *
 * The remaining gap is recorded honestly: the dock icon's Quit, and logout/restart, still
 * terminate immediately. None of those three is a place a hand slips and hits by accident,
 * and there is no way to intercept them either, for the reasons above.
 */
#[cfg(target_os = "macos")]
fn install_quit_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    // On macOS the first submenu is the app menu, and its **last item is Quit** (exactly the
    // shape tauri 2.11.5 menu/menu.rs's `Menu::default` builds).
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let items = app_menu.items()?;
        // Removing something that is not predefined would mean removing someone else's item —
        // if the shape does not match, leave it alone.
        if let Some(MenuItemKind::Predefined(_)) = items.last() {
            app_menu.remove_at(items.len() - 1)?;
            let quit =
                MenuItem::with_id(app, "cc-quit", "Quit Centralu", true, Some("CmdOrCtrl+Q"))?;
            app_menu.append(&quit)?;
        }
    }
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
fn host_info(sup: State<'_, Supervisor>) -> Option<HostInfo> {
    sup.info()
}

#[tauri::command]
fn host_error(sup: State<'_, Supervisor>) -> Option<String> {
    sup.last_error()
}

/// Retry from the failure screen (#184). Restarts a supervisor that has given up — merely
/// reloading the webview does not bring the host back up. Does nothing if it is still running
/// (an answer is coming soon anyway).
#[tauri::command]
fn restart_host(app: AppHandle, sup: State<'_, Supervisor>) -> bool {
    sup.restart(app)
}

/// The dock icon badge (FR-12, display layer ④).
/// Cleared when the count is 0 — a number left over with nothing to act on is noise, not a
/// signal.
#[tauri::command]
fn set_badge(app: AppHandle, count: u32) {
    let Some(window) = app.get_webview_window("main") else { return };
    if let Err(e) = write_badge(&window, count) {
        eprintln!("[badge] {e}");
    }
}

#[cfg(target_os = "macos")]
fn write_badge(window: &tauri::WebviewWindow, count: u32) -> tauri::Result<()> {
    // The dock badge is a text bubble on macOS, so we hand it the number as a label.
    window.set_badge_label(if count == 0 { None } else { Some(count.to_string()) })
}

#[cfg(not(target_os = "macos"))]
fn write_badge(window: &tauri::WebviewWindow, count: u32) -> tauri::Result<()> {
    // `set_badge_label` is `#[cfg(target_os = "macos")]` inside tauri itself, so the
    // macOS branch above is not merely wrong off macOS — it does not compile there.
    // `set_badge_count` is the portable call.
    //
    // Be honest about what it buys us on Linux: it goes out over the Unity launcher
    // D-Bus API, which only some desktops listen to (GNOME with dash-to-dock, KDE).
    // Everywhere else it lands nowhere and there is nothing this process can do about
    // it. That is why Linux must not depend on the badge to reach a person — the
    // desktop notification in `notify()` and the urgency hint in `alert()` do that.
    window.set_badge_count(if count == 0 { None } else { Some(i64::from(count)) })
}

/// Opens a file in the editor (cuts the round-trip cost described in FR-4).
#[tauri::command]
fn open_in_ide(path: String, line: Option<u32>) -> Result<(), String> {
    let native_path = std::path::Path::new(&path);
    assert_safe_native_path(native_path).map_err(|e| e.to_string())?;
    let target = match line {
        Some(l) => format!("{path}:{l}"),
        None => path.clone(),
    };
    // Only an IDE is allowed here. Falling back to the OS generic opener can execute
    // attacker-authored files instead of editing them; reveal_path is the safe file-manager path.
    // Passing the bare name fails to find it on an installed build — a GUI app's PATH does
    // not contain `code` (ide.rs, #159).
    let code = ide::find_code()?;
    std::process::Command::new(&code)
        .arg("-g")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", code.display()))
}

/// Shows the file in the file manager (the "Open in Finder" of #19).
///
/// Does not use `open` or `xdg-open` — those are commands that **open** a file, and if a
/// script was selected, they could execute it instead of just showing it. The plugin's
/// `reveal_item_in_dir` goes down to NSWorkspace on macOS and to org.freedesktop.FileManager1
/// on Linux (falling back to opening the parent folder if that is unavailable), which is the
/// "point at it, do not open it" kind of API.
///
/// Because this calls the plugin's **Rust function, not its JS command**, the
/// `opener:allow-reveal-item-in-dir` permission is not needed. What the webview calls is this
/// app's own command, and the only permission that needs is `allow-reveal-path` (build.rs,
/// capabilities/default.json).
///
/// The error returns **only the reason**. The screen already knows what it was trying to do
/// when it failed ("Could not show a.ts: …"), so appending that again here would say the same
/// thing twice.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let native_path = std::path::Path::new(&path);
    assert_safe_native_path(native_path).map_err(|e| e.to_string())?;
    tauri_plugin_opener::reveal_item_in_dir(native_path).map_err(|e| e.to_string())
}

/// Sends the file to the trash (#18) — this does not delete it.
///
/// This is the reason the trash was chosen over a confirmation dialog: the point where the
/// action can still be undone moves to **after** the click. A dialog can only be undone before
/// the click.
///
/// Switches the macOS backend to `NsFileManager`. The crate's default asks Finder to do it via
/// AppleScript, which prompts for automation permission (TCC), and if that is declined nothing
/// happens at all — this app has no signing certificate, so that prompt ends particularly
/// badly. The price is that Finder's "Put Back" context-menu item does not show up on some
/// versions of macOS (a macOS-side defect), but the file is still sitting in the trash and can
/// be dragged out, so the promise that this can be undone still holds. It is worse for
/// **deletion itself to fail silently** because a permission prompt got in the way.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    let native_path = std::path::Path::new(&path);
    assert_safe_native_path(native_path).map_err(|e| e.to_string())?;
    send_to_trash(native_path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn send_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

/// On Linux and Windows, the default backend already is the OS's own trash.
/// The Linux side is an implementation of the freedesktop trash spec 1.0, so GNOME, KDE and
/// XFCE all land in the same place — per the spec, a file on a different mount point goes to
/// that volume's own `.Trash-$uid`, and on a filesystem that cannot support that (FAT and the
/// like) the failure is surfaced as-is. That is better than deleting silently.
#[cfg(not(target_os = "macos"))]
fn send_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    trash::delete(path)
}

/// What this desktop calls its file manager.
///
/// The same trade as the keyboard labels (`shortcut_keys`): the UI cannot ask which OS it is
/// on, so it asks for a **name** and prints it as-is. Linux has no single answer (Nautilus,
/// Dolphin, Thunar), so it gets a generic noun instead of a guess.
#[tauri::command]
fn file_manager_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Finder"
    }
    #[cfg(target_os = "windows")]
    {
        "File Explorer"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "file manager"
    }
}

/// How much room the OS window controls take on the left edge of our own top bar, in px.
///
/// macOS keeps the traffic lights *inside* our overlay title bar, so the bar has to
/// leave a hole for them or the first thing we draw sits under the buttons. Other
/// desktops draw their decorations in a separate strip above our bar, so the bar owns
/// the full width and the same padding would just be dead space.
///
/// The UI is not allowed to ask which OS it is on (docs/platform-abstraction.md): it
/// asks how much room to leave and we answer. That keeps the one number that has to
/// agree with `traffic_lights::INSET_X` on this side of the boundary.
#[tauri::command]
fn window_controls_inset() -> u32 {
    #[cfg(target_os = "macos")]
    {
        // INSET_X (19) + the three 12px buttons and the gaps macOS puts between them,
        // plus breathing room before our first item.
        86
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// What this machine's keyboard prints on the two modifier keys the UI shows.
///
/// `join` is what goes between keys when a combination is written as one string. macOS
/// writes `⌘⇧A` with nothing in between, which reads because the parts are symbols; carry
/// that rule over to keyboards where the parts are words and you get `CtrlShiftA`.
#[derive(serde::Serialize)]
struct ShortcutKeys {
    // `mod` is a Rust keyword, so the field is named for what it is and renamed on the wire.
    #[serde(rename = "mod")]
    modifier: &'static str,
    alt: &'static str,
    join: &'static str,
}

/// The labels for shortcut hints, since the UI is not allowed to ask which OS it is on.
///
/// The bindings themselves need no help — every handler already takes `metaKey ||
/// ctrlKey`, so the shortcuts have always worked here and on Linux alike. It was only the
/// hints that were wrong, and they were wrong everywhere at once because `⌘` was written
/// out at each of them. A key that is not on the keyboard is a worse hint than none.
#[tauri::command]
fn shortcut_keys() -> ShortcutKeys {
    #[cfg(target_os = "macos")]
    {
        ShortcutKeys { modifier: "⌘", alt: "⌥", join: "" }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ShortcutKeys { modifier: "Ctrl", alt: "Alt", join: "+" }
    }
}

/// The two ways to call back a person who has stepped away — sound and the dock icon.
///
/// **This stands in for the banner, not alongside it.** On macOS, `tauri-plugin-notification`
/// goes through `NSUserNotification`, an API deprecated in 2018 (10.14), so nothing shows up
/// on a current OS at all. Worse, that plugin returns the permission state as a **constant**
/// (`Ok(PermissionState::Granted)`) and discards delivery failures with `let _ =` — so the app
/// could not even tell that not a single notification had gone out. This was confirmed by
/// measurement.
///
/// Sound and the dock icon go through neither the notification permission nor code signing.
/// This Mac has zero signing certificates (`security find-identity` → 0 valid identities), so
/// right now this is the only path that reaches the person.
///
/// On Linux the ranking is the other way round. The banner path there is real — the
/// notification plugin talks org.freedesktop.Notifications over D-Bus — while the badge
/// only reaches Unity-style launchers. So Linux leans on the banner, and this function
/// adds the two things a banner does not do: a sound, and an urgency hint on the window
/// so the taskbar entry keeps asking after the banner has faded.
#[tauri::command]
fn alert(app: AppHandle, kind: String, sound: bool) {
    if sound {
        play_sound(&kind);
    }
    let Some(window) = app.get_webview_window("main") else { return };
    // An approval or an error is only resolved once the person comes back, so it keeps
    // bouncing the dock icon until they do.
    // A completion only needs to be announced, so it bounces once — bouncing forever for
    // something that is already finished would just be nagging.
    let attention = if kind == "done" || kind == "all_done" {
        tauri::UserAttentionType::Informational
    } else {
        tauri::UserAttentionType::Critical
    };
    if let Err(e) = window.request_user_attention(Some(attention)) {
        eprintln!("[alert] dock icon: {e}");
    }
}

/// Plays one sound from `/System/Library/Sounds`.
///
/// `NSSound` looks lighter, but playback is asynchronous and the object has to be kept alive,
/// which needs storage that can cross threads (`Retained<NSSound>` is not Send). Rather than
/// pay that weight for one short sound, this hands the job to `afplay` — alerts fire rarely.
///
/// The argument is the alert *kind*, not a sound name. It used to be a macOS sound name
/// picked by the caller, which meant the caller had to know what macOS calls its sounds
/// — and there was no honest way for another OS to answer that question.
#[cfg(target_os = "macos")]
fn play_sound(kind: &str) {
    // Distinguishing the sounds is a feature, not a taste — it tells someone in the next room
    // what happened without looking.
    let name = match kind {
        "error" => "Basso",    // the sound macOS has long used for "something is wrong"
        "done" => "Tink",      // one thing finished — light
        "all_done" => "Glass", // everything is finished
        _ => "Submarine",      // waiting (an approval)
    };
    let path = format!("/System/Library/Sounds/{name}.aiff");
    if let Err(e) = spawn_and_reap("/usr/bin/afplay", &[&path]) {
        eprintln!("[alert] failed to play sound ({path}): {e}");
    }
}

/// Same four meanings, spoken in freedesktop terms.
///
/// The names are XDG sound-theme event ids, not file paths, because the file layout is
/// not portable across distributions but the event ids are (the sound theme spec is what
/// every desktop implements). `canberra-gtk-play` resolves the id through the user's
/// chosen theme and honours their event-sound setting; if it is not installed we fall
/// back to playing the freedesktop theme file directly through PulseAudio/PipeWire.
///
/// If neither exists we say so once. A silent failure here is exactly the bug this whole
/// alert path was written to avoid: the person who walked away never learns that the
/// thing meant to call them back was never able to make a sound.
///
/// Known gap, stated rather than hidden: we only notice whether the player *started*,
/// not whether it found the sound. If canberra is installed but the sound theme is not,
/// it exits non-zero after we have already stopped looking, and the alert is silent.
/// Waiting for the exit status would mean blocking the alert path on a subprocess,
/// which is a worse trade for something that fires on every turn.
#[cfg(target_os = "linux")]
fn play_sound(kind: &str) {
    let event = match kind {
        "error" => "dialog-error",
        "done" => "complete",
        "all_done" => "complete",
        _ => "message", // waiting on a human (approval)
    };
    if spawn_and_reap("canberra-gtk-play", &["-i", event]).is_ok() {
        return;
    }
    let file = format!("/usr/share/sounds/freedesktop/stereo/{event}.oga");
    if std::path::Path::new(&file).exists() && spawn_and_reap("paplay", &[&file]).is_ok() {
        return;
    }
    warn_once(
        "[alert] no way to play a sound: install libcanberra-gtk3 (canberra-gtk-play) \
         or pulseaudio-utils (paplay). Notifications still go out; only the sound is missing.",
    );
}

/// Deliberately silent, and deliberately not a compile error.
///
/// Windows is not supported yet (issue #14 covers Linux only). Leaving `play_sound`
/// undefined for it would break the build before anyone got as far as finding out what
/// else is missing, so this arm exists to keep the failure where it belongs.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn play_sound(_kind: &str) {}

/// Spawns a fire-and-forget child and reaps it. `Err` means it could not start at all.
///
/// The reaping matters: without it every alert leaves a zombie behind, and alerts fire
/// for the whole life of the app. The error is handed back rather than logged here
/// because the caller knows what it was trying to play, and "could not play a sound"
/// without the reason is the kind of log line nobody can act on.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawn_and_reap(program: &str, args: &[&str]) -> std::io::Result<()> {
    let mut child = std::process::Command::new(program).args(args).spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Says a thing once. Repeating it on every alert would itself become the noise.
#[cfg(target_os = "linux")]
fn warn_once(message: &str) {
    static SAID: std::sync::Once = std::sync::Once::new();
    SAID.call_once(|| eprintln!("{message}"));
}

/// Brings the window to the front (used by clicking a notification and by the global
/// shortcut).
#[tauri::command]
fn focus_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/**
 * The person confirmed quitting in the modal (dogfooding, 2026-09-04: prevent an immediate
 * quit from ⌘Q/⌘W).
 *
 * The flag is set before calling exit — this exit in turn produces another ExitRequested, and
 * the gate (the run callback below) has to let it through at that point. The flag is the
 * source of truth because a platform could exist where the gate, looking only at the code
 * (Some/None), cannot tell our own exit apart from a system terminate.
 */
#[tauri::command]
fn quit_app(app: AppHandle, approved: State<QuitApproved>) {
    approved.0.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/** The quit-confirmed flag — only the modal's "Quit" sets this. */
struct QuitApproved(std::sync::Arc<std::sync::atomic::AtomicBool>);

/**
 * App links (M4 E-4) — `centralu://app?url=…`.
 *
 * macOS hands a link on a registered scheme (CFBundleURLTypes in Info.plist) to the app as an
 * Apple Event, and Tauri gives it to us as `RunEvent::Opened`. Why this does not use the
 * deep-link plugin: to receive the same event, the plugin opens more commands to the webview
 * (up to and including registering the scheme at runtime). The only command added here is
 * pulling the queued links back out.
 *
 * A link is text someone else wrote. This only filters on shape — the scheme has to be
 * `centralu`, the length has to be under the cap, and there can only be a handful at once.
 * The decision of what to open belongs to the screen (`parseAppLink`), what to read and
 * download belongs to the host (`classifySource`), and before either of those, the person has
 * to click through a confirmation window.
 *
 * Why the links are queued: when the app is first launched by a link, the link arrives before
 * the webview is listening. So the event (`app-link`) is only a doorbell saying "come get it",
 * and the link itself is pulled out with `take_app_links` — one link never travels twice, once
 * as the event and once as the thing pulled out.
 */
const APP_LINK_MAX_CHARS: usize = 4096;
const APP_LINKS_KEPT: usize = 8;

#[derive(Default)]
struct AppLinks(std::sync::Mutex<Vec<String>>);

/** Is this an acceptable shape — starts with `centralu:` (case-insensitive) and within the
 * length cap. */
fn accept_app_link(url: &str) -> Option<String> {
    if url.len() > APP_LINK_MAX_CHARS {
        return None;
    }
    let scheme = url.get(..9)?;
    if !scheme.eq_ignore_ascii_case("centralu:") {
        return None;
    }
    Some(url.to_string())
}

/** Pulls out the queued app links — clears what it takes (each link goes out only once). */
#[tauri::command]
fn take_app_links(links: State<'_, AppLinks>) -> Vec<String> {
    let mut held = links.0.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *held)
}

/** Receives a link the OS handed over — filters it, queues it, wakes the webview, and brings
 * the window forward (whoever clicked the link has to see the confirmation window). */
#[cfg(target_os = "macos")]
fn receive_app_links<'a>(app: &AppHandle, urls: impl Iterator<Item = &'a str>) {
    let mut took = false;
    {
        let state = app.state::<AppLinks>();
        let mut held = state.0.lock().unwrap_or_else(|e| e.into_inner());
        for u in urls {
            if let Some(link) = accept_app_link(u) {
                if held.len() < APP_LINKS_KEPT {
                    held.push(link);
                    took = true;
                }
            }
        }
    }
    if !took {
        return;
    }
    let _ = app.emit("app-link", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod app_link_tests {
    use super::accept_app_link;

    #[test]
    fn only_centralu_links_under_the_cap() {
        assert_eq!(
            accept_app_link("centralu://app?url=https://example.com/a.zip").as_deref(),
            Some("centralu://app?url=https://example.com/a.zip")
        );
        assert!(accept_app_link("CENTRALU://app?url=x").is_some());
        for bad in ["https://example.com/a.zip", "file:///etc/passwd", "centralux://app", "central", ""] {
            assert_eq!(accept_app_link(bad), None, "{bad}");
        }
        let long = format!("centralu://app?url=https://example.com/{}", "a".repeat(4096));
        assert_eq!(accept_app_link(&long), None);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[cfg(target_os = "macos")]
mod traffic_lights;

pub fn run() {
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
            take_app_links
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
            // Make sure the sidecar is killed when the app closes (no zombie processes).
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                supervisor.shutdown();
                let _ = app.emit("host-status", "shutdown");
            }
        });
}
