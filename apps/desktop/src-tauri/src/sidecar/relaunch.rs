//! Whether "Apply now" can relaunch this window into the update just installed (#352). Unix only, as
//! the keeper is: elsewhere the window refuses a relaunch (`Supervisor::relaunch_info`).

use super::RelaunchInfo;

/**
 * Whether relaunching starts a different build than this window (#352), from what is on disk now.
 *
 * - No bundle around the executable (`pnpm app:dev`, a bare binary): a relaunch starts the same
 *   build, and the update went to the installed app, not here.
 * - Nothing readable on disk where the build should be: the bundle is half replaced or gone, and a
 *   relaunch could start nothing at all.
 * - The same build on disk as this window: the update did not replace this bundle. This is the
 *   case of `pnpm app:open`, which runs the build output in place while `centralu install` writes
 *   `/Applications/Centralu.app`.
 */
pub(crate) fn relaunch_decision(
    app: &crate::keeper::source::BuildSource,
    on_disk: Option<&crate::keeper::source::BuildSource>,
    in_bundle: bool,
    bundle: &str,
) -> RelaunchInfo {
    let not = |reason: String| RelaunchInfo { reason: Some(reason), bundle_path: Some(bundle.to_string()), ..Default::default() };
    if !in_bundle {
        return not("This window does not run from an app bundle, so relaunching would start the same build. Open the installed Centralu to finish.".into());
    }
    let Some(on_disk) = on_disk else {
        return not(format!("The app at {bundle} is incomplete right now, so relaunching could start nothing. Open Centralu again by hand."));
    };
    if on_disk.same_build(app) {
        return not(format!(
            "This window runs from {bundle}, which the update did not replace. Open the installed Centralu to use the new version."
        ));
    }
    RelaunchInfo { ready: true, bundle_path: Some(bundle.to_string()), ..Default::default() }
}

/**
 * `relaunch_decision` for this window, from what is on disk now: this window's own build `app`, and the host folder the
 * bundle carries (`host_dir`, None for a dev build, which has none to compare). The window that has a keeper and the one
 * that starts its host itself ask the same question (#1895).
 */
pub(crate) fn relaunch_info(app: &crate::keeper::source::BuildSource, host_dir: Option<&std::path::Path>) -> RelaunchInfo {
    use crate::keeper::source::BuildSource;
    let exe = std::env::current_exe().unwrap_or_default();
    let bundle = crate::keeper::client::bundle_of(&exe);
    let on_disk = host_dir
        .filter(|d| d.join("main.mjs").is_file() && exe.is_file())
        .map(|d| BuildSource::from_host_dir(d, Some(bundle.to_string_lossy().to_string()), None));
    let mut info = relaunch_decision(app, on_disk.as_ref(), bundle != exe, &bundle.to_string_lossy());
    if info.ready {
        info.version = bundle_version(&bundle);
    }
    info
}

/// What a window that starts its host itself compares the bundle on disk with (#1895): its own build as it started, and the
/// host folder it carries. Kept at start, since the update replaces the folder the build would be read from.
static DIRECT_APP: std::sync::OnceLock<(crate::keeper::source::BuildSource, Option<std::path::PathBuf>)> = std::sync::OnceLock::new();

/// Keeps this window's own build for `direct_info`; the first call is the one that counts
pub(crate) fn remember(host_dir: Option<std::path::PathBuf>, version: &str) {
    let _ = DIRECT_APP.set((app_build(host_dir.as_deref(), version), host_dir));
}

/// `relaunch_info` for a window that starts its host itself: a relaunch there stops it for an update (`restarts_host`)
pub(crate) fn direct_info() -> RelaunchInfo {
    let not = |reason: &str| RelaunchInfo { reason: Some(reason.into()), ..Default::default() };
    match DIRECT_APP.get() {
        Some((build, Some(host_dir))) => RelaunchInfo { restarts_host: true, ..relaunch_info(build, Some(host_dir)) },
        Some((_, None)) => not("This window does not run the host bundled with the app, so relaunching would not start the update."),
        None => not("This window has not started its host yet."),
    }
}

/// This window's own build, from the host folder it carries (None for a dev build) and the app's version
pub(crate) fn app_build(host_dir: Option<&std::path::Path>, version: &str) -> crate::keeper::source::BuildSource {
    use crate::keeper::source::BuildSource;
    match host_dir {
        Some(dir) => {
            let exe = std::env::current_exe().unwrap_or_default();
            BuildSource::from_host_dir(dir, Some(crate::keeper::client::bundle_of(&exe).to_string_lossy().to_string()), Some(version.to_string()))
        }
        None => BuildSource::dev(),
    }
}

/// The version in a bundle's `Info.plist` (`CFBundleShortVersionString`), read as text: Tauri
/// writes an XML plist, and this is for showing a version, so an unreadable one is just absent.
pub(crate) fn bundle_version(bundle: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    plist_string(&text, "CFBundleShortVersionString")
}

fn plist_string(text: &str, key: &str) -> Option<String> {
    let after = &text[text.find(&format!("<key>{key}</key>"))?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    let v = after[start..start + end].trim();
    (!v.is_empty() && v.len() <= 64).then(|| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #352: "Apply now" is only offered when relaunching starts the build the update installed.
    #[test]
    fn apply_now_relaunches_only_into_a_different_build_on_disk() {
        use crate::keeper::source::BuildSource;
        let build = |commit: &str| BuildSource { commit: commit.into(), ..Default::default() };
        let app = build("aaaaaaa");
        let ready = relaunch_decision(&app, Some(&build("bbbbbbb")), true, "/Applications/Centralu.app");
        assert!(ready.ready, "the bundle now holds another build: relaunching applies it");
        let same = relaunch_decision(&app, Some(&build("aaaaaaa")), true, "/x/target/release/bundle/macos/Centralu.app");
        assert!(!same.ready, "pnpm app:open: the update did not replace this bundle");
        assert!(same.reason.unwrap().contains("did not replace"));
        assert!(!relaunch_decision(&app, Some(&build("bbbbbbb")), false, "/x/centralu").ready, "no bundle: the same binary again");
        assert!(!relaunch_decision(&app, None, true, "/Applications/Centralu.app").ready, "nothing on disk to start");
    }

    #[test]
    fn reads_the_version_from_an_xml_plist() {
        let plist = "<dict>\n\t<key>CFBundleName</key>\n\t<string>Centralu</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.1.0-beta.11</string>\n</dict>";
        assert_eq!(plist_string(plist, "CFBundleShortVersionString").as_deref(), Some("0.1.0-beta.11"));
        assert_eq!(plist_string(plist, "CFBundleVersion"), None);
    }
}
