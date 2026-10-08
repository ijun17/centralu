//! What an AppImage leaves on the processes it starts, and how a keeper running from a copy sheds it
//! (lessons FI4 and FI5, docs/spikes/2026-10-linux-keeper.md §6).
//!
//! The AppImage runtime keeps its squashfs mounted while any process holds the read end of its
//! keep-alive pipe or its descriptor of the mount, and neither is close-on-exec: the window passes
//! both to the keeper it starts, and the keeper to its host and every terminal and agent. Its AppRun
//! sets variables that point into the mount (`APPDIR`, GTK's and GDK's module paths, entries of
//! `XDG_DATA_DIRS` and `PATH`), which reach the same processes. Once nothing runs from the mount (the
//! keeper runs from `<data>/content/<version>/`, `carried.rs`), both are only leaks: a mount and its
//! FUSE server for the keeper's life, an updated-away AppImage kept on disk, and children whose
//! environment names files that are gone. A keeper from content sheds them before it does anything
//! else; one started from the mount keeps them, since they are what keeps its own code there.

use std::os::fd::RawFd;

/// Variables the AppImage runtime sets that only mean something inside it.
const RUNTIME_VARS: [&str; 4] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/**
 * How to change the environment `vars` so that nothing of the AppImage mounted at its `APPDIR` is
 * left: the runtime's own variables go, and every variable loses the `:`-separated entries inside
 * the mount (a variable left with none goes too). `None` removes, `Some` sets. Nothing changes
 * without an `APPDIR`, so this does nothing outside an AppImage.
 */
pub fn env_changes(vars: &[(String, String)]) -> Vec<(String, Option<String>)> {
    let Some(appdir) = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.trim_end_matches('/').to_string()) else {
        return Vec::new();
    };
    if appdir.is_empty() {
        return Vec::new();
    }
    let inside = |entry: &str| entry == appdir || entry.starts_with(&format!("{appdir}/"));
    let mut out = Vec::new();
    for (k, v) in vars {
        if RUNTIME_VARS.contains(&k.as_str()) {
            out.push((k.clone(), None));
        } else if v.split(':').any(inside) {
            let kept: Vec<&str> = v.split(':').filter(|e| !inside(e)).collect();
            let kept = kept.join(":");
            out.push((k.clone(), if kept.is_empty() { None } else { Some(kept) }));
        }
    }
    out
}

/// Sheds what the AppImage left on this process: its variables and every inherited descriptor but
/// `keep` (a handoff's channel). Only at the very start of a keeper that runs from content, while
/// it is a single thread. Returns what it did, for the log.
pub fn shed(keep: Option<RawFd>) -> String {
    let vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    let changes = env_changes(&vars);
    for (k, v) in &changes {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
    let closed = crate::os::close_inherited(&keep.into_iter().collect::<Vec<_>>());
    let names: Vec<&str> = changes.iter().map(|(k, _)| k.as_str()).collect();
    format!("closed inherited descriptors {closed:?}; cleaned variables {names:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// FI5, with what AppRun and the GTK hook of an AppImage of Centralu set.
    #[test]
    fn nothing_that_points_into_the_mount_is_left() {
        let m = "/tmp/.mount_CentraXYZ";
        let got = env_changes(&vars(&[
            ("APPDIR", &format!("{m}/")),
            ("APPIMAGE", "/home/me/.npm/centralu/Centralu.AppImage"),
            ("ARGV0", "Centralu.AppImage"),
            ("OWD", "/home/me"),
            ("XDG_DATA_DIRS", &format!("{m}/usr/share:/usr/local/share:/usr/share")),
            ("GDK_PIXBUF_MODULE_FILE", &format!("{m}/usr/lib/gdk-pixbuf-2.0/loaders.cache")),
            ("GTK_PATH", &format!("{m}/usr/lib/gtk-3.0")),
            ("PATH", &format!("{m}/usr/bin:/usr/bin:/bin")),
            ("HOME", "/home/me"),
            ("NOT_IT", &format!("{m}x/usr/share")),
        ]));
        let get = |k: &str| got.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        for k in ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "GDK_PIXBUF_MODULE_FILE", "GTK_PATH"] {
            assert_eq!(get(k), Some(None), "{k} goes");
        }
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some("/usr/local/share:/usr/share".into())));
        assert_eq!(get("PATH"), Some(Some("/usr/bin:/bin".into())));
        assert_eq!(get("HOME"), None, "the person's own variables are left alone");
        assert_eq!(get("NOT_IT"), None, "a folder that only starts with the mount's name is not in it");
    }

    #[test]
    fn outside_an_appimage_nothing_changes() {
        assert!(env_changes(&vars(&[("PATH", "/usr/bin"), ("OWD", "/home/me")])).is_empty());
        assert!(env_changes(&vars(&[("APPDIR", ""), ("PATH", "/usr/bin")])).is_empty());
    }
}
