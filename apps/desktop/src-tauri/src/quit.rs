//! Quitting asks first: the Quit item of the macOS menu and the flag the modal's "Quit" sets. The
//! exit gate that reads the flag is in `run` (lib.rs).

use tauri::{AppHandle, State};

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
pub(crate) fn install_quit_menu(app: &AppHandle) -> tauri::Result<()> {
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
pub(crate) fn quit_app(app: AppHandle, approved: State<QuitApproved>) {
    approved.0.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

/** The quit-confirmed flag — only the modal's "Quit" sets this. */
pub(crate) struct QuitApproved(pub(crate) std::sync::Arc<std::sync::atomic::AtomicBool>);
