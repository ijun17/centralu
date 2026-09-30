//! Vertically centers the macOS traffic light buttons in our top bar.
//!
//! `trafficLightPosition` in `tauri.conf.json` is not enough on its own. Starting with macOS
//! 26 (Sequoia), the window manager **does not settle the button position synchronously with
//! the resize event**, so the buttons snap back to their default spot every time the window
//! appears or is resized. Measurement confirmed this too: the setting was present in the
//! binary, yet on screen the buttons stayed pinned to the top.
//!
//! So this repositions them on every window event instead. The setting itself is left in
//! place — it decides the position before the first frame is drawn, and this takes
//! responsibility for everything after that.
//!
//! **We do not decide the spacing between the buttons.** All three are shifted together by the
//! difference between where the first button should be and where it currently is. Leaving the
//! spacing macOS chose alone is better than writing down a number like 20pt ourselves and
//! having it drift out of sync whenever the OS changes.

use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
use tauri::{Manager, WindowEvent};

/// The top bar's height in px. Has to match `h-9` in packages/ui's App.tsx.
const HEADER_H: f64 = 36.0;
/// From the left edge of the window to the first button.
const INSET_X: f64 = 19.0;

/// Puts the traffic lights back in place after the window appears and whenever its shape
/// changes.
pub fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };

    apply(&window);

    // Why this has to reposition a few more times right after the event:
    // macOS 26 **delivers the resize event first and settles the window frame afterward.** So
    // the position captured at event time is immediately pushed out of place — this is the
    // "resizing occasionally looks wrong" that was flagged during dogfooding.
    //
    // This used to spawn 3 fresh threads per event, but during a drag, events arrive dozens of
    // times per second, so threads piled up into the hundreds. Now a **single long-lived
    // thread** receives signals over a channel and recalibrates. Signals that pile up while it
    // is calibrating are collapsed into one — it is the same job either way ("reposition based
    // on the current frame"), so doing it once is enough.
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    {
        let w = window.clone();
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // HuLa runs at 60Hz for up to 10 seconds. We reposition only three times per
                // signal (at 16/64/200ms from the event): while the window is being dragged,
                // signals keep arriving and that itself acts as the polling, and it naturally
                // stops once the hand is lifted.
                for wait_ms in [16u64, 48, 136] {
                    std::thread::sleep(std::time::Duration::from_millis(wait_ms));
                    let inner = w.clone();
                    // AppKit can only be touched from the main thread.
                    if w.run_on_main_thread(move || apply(&inner)).is_err() {
                        return; // The window is gone — nothing left to do.
                    }
                }
                // Signals that piled up while calibrating are the same job as the one just
                // handled — drain them.
                while rx.try_recv().is_ok() {}
            }
        });
    }

    let w = window.clone();
    window.on_window_event(move |event| {
        // Why Moved is watched too: moving between screens can change the scale factor, which
        // shifts the coordinates.
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            apply(&w);
            let _ = tx.send(());
        }
    });
}

fn apply(window: &tauri::WebviewWindow) {
    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // SAFETY: the pointer Tauri gives us is this window's NSWindow. Only used while the window
    // is alive.
    unsafe {
        let ns: &NSWindow = &*(ptr as *const NSWindow);
        place(ns);
    }
}

/// # Safety
/// `ns` has to be a live NSWindow, and this must only be called from the main thread.
unsafe fn place(ns: &NSWindow) {
    let Some(close) = ns.standardWindowButton(NSWindowButton::CloseButton) else { return };
    let Some(bar) = close.superview() else { return };

    let bar_h = bar.frame().size.height;
    let btn = close.frame();

    // AppKit's origin is the **bottom** left, so lowering by y from the top means computing it
    // upside down.
    let want_y = bar_h - (HEADER_H - btn.size.height) / 2.0 - btn.size.height;
    let dx = INSET_X - btn.origin.x;
    let dy = want_y - btn.origin.y;
    if dx.abs() < 0.5 && dy.abs() < 0.5 {
        return; // Already in place — do not touch it on every frame.
    }

    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(view) = ns.standardWindowButton(kind) else { continue };
        shift(&view, dx, dy);
    }
}

unsafe fn shift(view: &Retained<objc2_app_kit::NSButton>, dx: f64, dy: f64) {
    let mut f = view.frame();
    f.origin.x += dx;
    f.origin.y += dy;
    let v: &NSView = view;
    v.setFrameOrigin(f.origin);
}
