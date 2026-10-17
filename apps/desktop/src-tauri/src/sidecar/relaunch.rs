//! Whether "Apply now" can relaunch this window into the update just installed (#352). Unix only, as
//! the keeper is: in direct mode the window refuses a relaunch (`Supervisor::relaunch_info`).

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
    RelaunchInfo { ready: true, reason: None, version: None, bundle_path: Some(bundle.to_string()) }
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
