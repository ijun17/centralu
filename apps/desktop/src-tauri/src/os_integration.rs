//! The window's own OS integration (docs/plans/runtime-unification.md §3.3): the badge, sounds and
//! the dock icon, opening the IDE, the file manager and the trash, and what the UI may not ask the OS
//! itself (the file manager's name, the window controls' room, the keyboard's labels).

use tauri::{AppHandle, Manager};

use crate::host_proc;
use crate::ide;
use crate::path_safety::{self, assert_safe_native_path};

/// The dock icon badge (FR-12, display layer ④).
/// Cleared when the count is 0 — a number left over with nothing to act on is noise, not a
/// signal.
#[tauri::command]
pub(crate) fn set_badge(app: AppHandle, count: u32) {
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
pub(crate) fn open_in_ide(path: String, line: Option<u32>) -> Result<(), String> {
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
    let mut cmd = std::process::Command::new(&code);
    cmd.arg("-g").arg(&target);
    // Windows: `code.cmd` runs under cmd.exe, which would flash a console window. Rust quotes
    // the arguments for cmd.exe itself, and refuses one it cannot pass safely.
    host_proc::hide_console(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| format!("{}: {e}", code.display()))
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
pub(crate) fn reveal_path(path: String) -> Result<(), String> {
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
pub(crate) fn trash_path(path: String) -> Result<(), String> {
    let native_path = std::path::Path::new(&path);
    // The entry itself, a link included (#838): the `trash` crate canonicalizes only the parent,
    // so a link is moved as the link and what it points at stays where it is
    path_safety::assert_safe_native_entry(native_path).map_err(|e| e.to_string())?;
    send_to_trash(native_path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn send_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx.delete(path)
}

/// On Linux, the default backend already is the OS's own trash.
/// The Linux side is an implementation of the freedesktop trash spec 1.0, so GNOME, KDE and
/// XFCE all land in the same place — per the spec, a file on a different mount point goes to
/// that volume's own `.Trash-$uid`, and on a filesystem that cannot support that (FAT and the
/// like) the failure is surfaced as-is. That is better than deleting silently.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn send_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    trash::delete(path)
}

/// Windows: the Recycle Bin, through the shell's `IFileOperation`.
///
/// The crate initialises COM on the calling thread, single-threaded apartment, and **panics**
/// when that fails — which it does on a thread already initialised as multithreaded. With
/// `panic = "abort"` that would take the whole app down. A thread of our own has no COM state
/// yet, so the call cannot meet a mode it did not choose.
#[cfg(target_os = "windows")]
fn send_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    let owned = path.to_path_buf();
    std::thread::spawn(move || trash::delete(&owned))
        .join()
        .unwrap_or_else(|_| Err(trash::Error::Unknown { description: "the trash thread panicked".into() }))
}

/// What this desktop calls its file manager.
///
/// The same trade as the keyboard labels (`shortcut_keys`): the UI cannot ask which OS it is
/// on, so it asks for a **name** and prints it as-is. Linux has no single answer (Nautilus,
/// Dolphin, Thunar), so it gets a generic noun instead of a guess.
#[tauri::command]
pub(crate) fn file_manager_name() -> &'static str {
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
pub(crate) fn window_controls_inset() -> u32 {
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

/// Whether the top bar draws the window's own minimize, maximize and close (owner, 2026-10-18).
///
/// On Windows the OS title bar is turned off at startup (`lib.rs`, setup) so the top bar is the only
/// strip, as on macOS where the traffic lights sit inside it; the controls it took away are drawn in
/// the bar instead. Answered as a yes/no so the UI never learns which OS it is on.
#[tauri::command]
pub(crate) fn window_controls_drawn() -> bool {
    cfg!(target_os = "windows")
}

/// What this machine's keyboard prints on the two modifier keys the UI shows.
///
/// `join` is what goes between keys when a combination is written as one string. macOS
/// writes `⌘⇧A` with nothing in between, which reads because the parts are symbols; carry
/// that rule over to keyboards where the parts are words and you get `CtrlShiftA`.
#[derive(serde::Serialize)]
pub(crate) struct ShortcutKeys {
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
pub(crate) fn shortcut_keys() -> ShortcutKeys {
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
pub(crate) fn alert(app: AppHandle, kind: String, sound: bool) {
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
/// Windows (#14) has no sound here yet: the alert still flashes the taskbar button
/// (`request_user_attention`), and the notification plugin's toast is the other way to reach
/// the person (neither has been seen on a Windows machine yet). A system sound
/// (`PlaySoundW` with an alias such as `SystemAsterisk`) is the obvious next step once
/// someone can hear it.
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
pub(crate) fn focus_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
