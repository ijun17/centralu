use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cc-shell-install-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn plist(version: u64) -> String {
    format!(
        "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>app.centralu.agent</string>\n  <key>CentraluShellVersion</key>\n  <integer>{version}</integer>\n</dict>\n</plist>\n"
    )
}

/// A shell bundle at `<dir>/Centralu.app` of `version`, whose executable holds `exe`.
fn bundle(dir: &Path, version: u64, exe: &str) -> PathBuf {
    let app = dir.join(SHELL_APP);
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(app.join("Contents/_CodeSignature")).unwrap();
    fs::write(app.join("Contents/Info.plist"), plist(version)).unwrap();
    fs::write(app.join("Contents/MacOS/centralu-shell"), exe).unwrap();
    fs::set_permissions(app.join("Contents/MacOS/centralu-shell"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(app.join("Contents/_CodeSignature/CodeResources"), format!("seal of {exe}")).unwrap();
    app
}

/// The window's resources carrying a shell of `version`, described as the release staging does.
fn carried(version: u64, exe: &str, pinned: bool) -> Carried {
    let resources = temp("res");
    let app = bundle(&resources.join("shell"), version, exe);
    let tree = tree_hash(&app).unwrap();
    fs::write(
        resources.join("shell").join(DESCRIPTOR),
        serde_json::json!({ "format": 1, "version": version, "tree": tree, "pinned": pinned }).to_string(),
    )
    .unwrap();
    read_carried(&resources).unwrap().expect("carried")
}

fn exe_of(app: &Path) -> String {
    fs::read_to_string(app.join("Contents/MacOS/centralu-shell")).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    v.sort();
    v
}

/// The same tree `tooling/bundle-stage.test.ts` hashes with `treeHash`: the two must agree.
#[test]
fn the_tree_hash_is_the_one_the_release_staging_writes() {
    let d = temp("tree");
    fs::create_dir_all(d.join("Contents/MacOS")).unwrap();
    fs::create_dir_all(d.join("Contents/Empty")).unwrap();
    fs::write(d.join("Contents/Info.plist"), "plist\n").unwrap();
    fs::write(d.join("Contents/MacOS/centralu-shell"), "exe\n").unwrap();
    fs::set_permissions(d.join("Contents/MacOS/centralu-shell"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(tree_hash(&d).unwrap(), "5c1c77146a6637356af8fb36a975dd7d4efac09faee11d08e1b4998b8b03a899");
    fs::set_permissions(d.join("Contents/MacOS/centralu-shell"), fs::Permissions::from_mode(0o644)).unwrap();
    assert_ne!(tree_hash(&d).unwrap(), "5c1c77146a6637356af8fb36a975dd7d4efac09faee11d08e1b4998b8b03a899", "the execute bit counts");
    std::os::unix::fs::symlink("Info.plist", d.join("Contents/link")).unwrap();
    assert!(tree_hash(&d).is_err(), "a symlink is refused");
}

#[test]
fn the_decision_table() {
    let c = carried(2, "two", true);
    let same = Installed::Shell { version: 2, tree: c.tree.clone() };
    let other_bytes = Installed::Shell { version: 2, tree: "0".repeat(64) };
    assert_eq!(plan(&c, &Installed::None), Plan::Install, "none installed");
    assert_eq!(plan(&c, &Installed::Unreadable), Plan::Install, "a damaged bundle is replaced");
    assert_eq!(plan(&c, &Installed::Shell { version: 1, tree: "1".repeat(64) }), Plan::Install, "older");
    assert_eq!(plan(&c, &same), Plan::Keep, "the same bytes");
    assert_eq!(plan(&c, &Installed::Shell { version: 3, tree: "3".repeat(64) }), Plan::Keep, "never a lower version over a higher one");
    assert_eq!(plan(&c, &other_bytes), Plan::Install, "pinned bytes replace a local build's shell of the same version");
    let local = Carried { pinned: false, ..c.clone() };
    assert_eq!(plan(&local, &other_bytes), Plan::Keep, "an unpinned shell never replaces one of its own version");
    assert_eq!(plan(&local, &Installed::Shell { version: 3, tree: "3".repeat(64) }), Plan::Keep);
    assert_eq!(plan(&local, &Installed::None), Plan::Install);
}

#[test]
fn none_installed_installs_the_carried_shell() {
    let c = carried(1, "one", true);
    let data = temp("data");
    let dir = shell_dir(&data);
    assert_eq!(installed(&dir), Installed::None);
    assert_eq!(install(&c, &dir).unwrap(), Swapped { old_aside: false });
    assert_eq!(installed(&dir), Installed::Shell { version: 1, tree: c.tree.clone() });
    assert_eq!(names(&dir), [SHELL_APP]);
    assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(dir.join(SHELL_APP).join("Contents/MacOS/centralu-shell")).unwrap().permissions().mode() & 0o777, 0o755);
}

#[test]
fn an_older_shell_is_upgraded_and_the_old_one_kept_until_the_new_one_started_a_keeper() {
    let data = temp("data");
    let dir = shell_dir(&data);
    install(&carried(1, "one", true), &dir).unwrap();
    let c = carried(2, "two", true);
    assert_eq!(plan(&c, &installed(&dir)), Plan::Install);
    assert_eq!(install(&c, &dir).unwrap(), Swapped { old_aside: true });
    assert_eq!(exe_of(&dir.join(SHELL_APP)), "two");
    assert_eq!(names(&dir), [OLD, SHELL_APP], "the old one waits aside");
    assert_eq!(exe_of(&dir.join(OLD)), "one");
    finish(&dir);
    assert_eq!(names(&dir), [SHELL_APP]);
}

#[test]
fn the_same_or_a_newer_shell_is_kept() {
    let data = temp("data");
    let dir = shell_dir(&data);
    let c = carried(2, "two", true);
    install(&c, &dir).unwrap();
    assert_eq!(plan(&c, &installed(&dir)), Plan::Keep);
    let newer = temp("data");
    let ndir = shell_dir(&newer);
    install(&carried(3, "three", true), &ndir).unwrap();
    assert_eq!(plan(&c, &installed(&ndir)), Plan::Keep);
    assert_eq!(exe_of(&ndir.join(SHELL_APP)), "three");
}

#[test]
fn a_corrupted_installed_bundle_is_replaced() {
    let data = temp("data");
    let dir = shell_dir(&data);
    let c = carried(1, "one", true);
    install(&c, &dir).unwrap();
    fs::remove_file(dir.join(SHELL_APP).join("Contents/Info.plist")).unwrap();
    assert_eq!(installed(&dir), Installed::Unreadable);
    assert_eq!(plan(&c, &installed(&dir)), Plan::Install);
    install(&c, &dir).unwrap();
    assert_eq!(installed(&dir), Installed::Shell { version: 1, tree: c.tree.clone() });
    // Same version, a file changed: not the pinned bytes any more.
    fs::write(dir.join(SHELL_APP).join("Contents/MacOS/centralu-shell"), "tampered").unwrap();
    assert_eq!(plan(&c, &installed(&dir)), Plan::Install);
}

#[test]
fn a_copy_that_does_not_hash_to_the_carried_hash_is_refused_and_the_old_shell_stays() {
    let data = temp("data");
    let dir = shell_dir(&data);
    install(&carried(1, "one", true), &dir).unwrap();
    let mut c = carried(2, "two", true);
    // The carried bytes are not what the release described (a damaged window bundle).
    fs::write(c.app.join("Contents/MacOS/centralu-shell"), "two, damaged").unwrap();
    let err = install(&c, &dir).unwrap_err();
    assert!(err.contains("hashes to"), "{err}");
    assert_eq!(exe_of(&dir.join(SHELL_APP)), "one");
    assert_eq!(names(&dir), [SHELL_APP], "no copy left behind");
    // And a descriptor naming another hash, the same way.
    c = carried(2, "two", true);
    c.tree = "f".repeat(64);
    assert!(install(&c, &dir).is_err());
    assert_eq!(exe_of(&dir.join(SHELL_APP)), "one");
}

#[test]
fn a_failure_at_any_step_leaves_the_installed_shell_in_place() {
    for step in [Step::Copy, Step::SetAside, Step::RenameIn] {
        let data = temp("data");
        let dir = shell_dir(&data);
        install(&carried(1, "one", true), &dir).unwrap();
        let fail = move |s: Step| if s == step { Err(io::Error::other("injected")) } else { Ok(()) };
        let err = install_with(&carried(2, "two", true), &dir, &fail).unwrap_err();
        assert!(err.contains("injected"), "{step:?}: {err}");
        assert!(dir.join(SHELL_APP).is_dir(), "{step:?}: no shell is installed any more: {:?}", names(&dir));
        assert_eq!(exe_of(&dir.join(SHELL_APP)), "one", "{step:?}: the old shell is still installed");
        assert_eq!(installed(&dir), Installed::Shell { version: 1, tree: tree_hash(&dir.join(SHELL_APP)).unwrap() });
        assert_eq!(names(&dir), [SHELL_APP], "{step:?}: nothing left behind");
    }
}

#[test]
fn a_window_that_stopped_between_the_renames_gets_the_old_shell_back() {
    let data = temp("data");
    let dir = shell_dir(&data);
    install(&carried(1, "one", true), &dir).unwrap();
    fs::rename(dir.join(SHELL_APP), dir.join(OLD)).unwrap();
    assert_eq!(installed(&dir), Installed::None);
    assert!(recover(&dir));
    assert_eq!(exe_of(&dir.join(SHELL_APP)), "one");
    assert!(!recover(&dir), "nothing to do when a shell is installed");
}

#[test]
fn a_carried_shell_must_match_its_description() {
    let resources = temp("res");
    assert_eq!(read_carried(&resources).unwrap(), None, "a bundle without a shell");
    bundle(&resources.join("shell"), 1, "one");
    assert!(read_carried(&resources).unwrap_err().contains("cannot read"), "a shell without shell.json");
    let write = |v: serde_json::Value| fs::write(resources.join("shell").join(DESCRIPTOR), v.to_string()).unwrap();
    write(serde_json::json!({ "format": 1, "version": 2, "tree": "a".repeat(64), "pinned": true }));
    assert!(read_carried(&resources).unwrap_err().contains("Info.plist"), "versions disagree");
    write(serde_json::json!({ "format": 1, "version": 1, "tree": "A".repeat(64), "pinned": true }));
    assert!(read_carried(&resources).unwrap_err().contains("tree"));
    write(serde_json::json!({ "format": 2, "version": 1, "tree": "a".repeat(64) }));
    assert!(read_carried(&resources).is_err());
    write(serde_json::json!({ "format": 1, "version": 1, "tree": "a".repeat(64) }));
    let c = read_carried(&resources).unwrap().unwrap();
    assert!(!c.pinned, "not pinned unless it says so");
    assert_eq!(c.version, 1);
}

#[test]
fn reads_the_shell_version_from_the_plist() {
    let d = temp("plist");
    let app = bundle(&d, 7, "x");
    assert_eq!(bundle_version(&app), Some(7));
    fs::write(app.join("Contents/Info.plist"), "<key>CentraluShellVersion</key><string>7</string>").unwrap();
    assert_eq!(bundle_version(&app), None);
}
