//! App links (`centralu://app?url=…`, M4 E-4): what the OS hands over, queued for the webview.

use tauri::State;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager};

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
// App links arrive on macOS only (docs/apps.md §12.3); elsewhere these wait for a receiver.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const APP_LINK_MAX_CHARS: usize = 4096;
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const APP_LINKS_KEPT: usize = 8;

#[derive(Default)]
pub(crate) struct AppLinks(std::sync::Mutex<Vec<String>>);

/** Is this an acceptable shape — starts with `centralu:` (case-insensitive) and within the
 * length cap. */
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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
pub(crate) fn take_app_links(links: State<'_, AppLinks>) -> Vec<String> {
    let mut held = links.0.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *held)
}

/** Receives a link the OS handed over — filters it, queues it, wakes the webview, and brings
 * the window forward (whoever clicked the link has to see the confirmation window). */
#[cfg(target_os = "macos")]
pub(crate) fn receive_app_links<'a>(app: &AppHandle, urls: impl Iterator<Item = &'a str>) {
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
