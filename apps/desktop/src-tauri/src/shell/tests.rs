//! The start decision end to end, with real folders and a fake LaunchServices.

use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cc-shell-start-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// The window's `Contents/Resources` carrying shell `version` (with `exe` as its executable).
fn resources(version: u64, exe: &str, pinned: bool) -> PathBuf {
    let r = temp("res");
    let app = r.join("shell").join(install::SHELL_APP);
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    fs::write(app.join("Contents/Info.plist"), format!("<key>CentraluShellVersion</key>\n<integer>{version}</integer>")).unwrap();
    fs::write(app.join("Contents/MacOS/centralu-shell"), exe).unwrap();
    fs::set_permissions(app.join("Contents/MacOS/centralu-shell"), fs::Permissions::from_mode(0o755)).unwrap();
    let tree = install::tree_hash(&app).unwrap();
    fs::write(r.join("shell").join(install::DESCRIPTOR), json!({ "format": 1, "version": version, "tree": tree, "pinned": pinned }).to_string()).unwrap();
    fs::create_dir_all(r.join("content")).unwrap();
    r
}

/// LaunchServices that "runs" the shell by answering with `answer` (`None`: never reports).
struct Fake {
    alive: bool,
    answer: Option<Value>,
    opened: RefCell<Vec<(PathBuf, Vec<String>)>>,
}

impl Fake {
    fn new(answer: Option<Value>) -> Fake {
        Fake { alive: false, answer, opened: RefCell::new(Vec::new()) }
    }
}

impl World for Fake {
    fn keeper_alive(&self) -> bool {
        self.alive
    }
    fn open_shell(&self, app: &Path, args: &[String]) -> Result<(), String> {
        assert!(app.join("Contents/Info.plist").is_file(), "opens an installed shell");
        self.opened.borrow_mut().push((app.to_path_buf(), args.to_vec()));
        Ok(())
    }
    fn read_status(&self) -> Option<Value> {
        let mut v = self.answer.clone()?;
        v["nonce"] = json!(self.opened.borrow().last()?.1.last()?.clone());
        Some(v)
    }
    fn sleep(&self, _: Duration) {}
}

fn started() -> Option<Value> {
    Some(json!({ "format": 1, "result": "started" }))
}

fn refused(reason: &str) -> Option<Value> {
    Some(json!({ "format": 1, "result": "refused", "reason": reason, "message": format!("the shell said {reason}") }))
}

#[test]
fn a_keeper_answering_installs_and_opens_nothing() {
    let (res, data) = (resources(1, "one", true), temp("data"));
    let w = Fake { alive: true, ..Fake::new(started()) };
    assert_eq!(start_keeper(&res, &data, None, false, &w), None);
    assert!(w.opened.borrow().is_empty());
    assert!(!install::shell_dir(&data).exists());
}

#[test]
fn a_release_installs_the_shell_and_starts_the_keeper_through_it() {
    let (res, data) = (resources(1, "one", true), temp("data"));
    let w = Fake::new(started());
    let r = start_keeper(&res, &data, Some("/Applications/Centralu.app".into()), false, &w).unwrap();
    assert_eq!(r, Report { started: true, reason: None, message: None, notify: true, shell_version: Some(1) });
    let opened = w.opened.borrow();
    assert_eq!(opened[0].0, data.join("shell/Centralu.app"));
    let args = &opened[0].1;
    assert_eq!(args[..6], ["--content".to_string(), res.join("content").display().to_string(), "--data-dir".into(), data.display().to_string(), "--bundle-path".into(), "/Applications/Centralu.app".into()]);
    let log = fs::read_to_string(data.join("keeper.log")).unwrap();
    assert!(log.contains("[window] installed shell 1"), "{log}");
}

#[test]
fn an_upgrade_removes_the_old_shell_only_after_the_new_one_started_a_keeper() {
    let data = temp("data");
    start_keeper(&resources(1, "one", true), &data, None, false, &Fake::new(started())).unwrap();
    let dir = install::shell_dir(&data);

    // The new shell refuses: the old one stays aside, the new one stays installed.
    let r = start_keeper(&resources(2, "two", true), &data, None, false, &Fake::new(refused("content"))).unwrap();
    assert!(!r.started);
    assert!(dir.join(".Centralu.app.old").exists());
    assert_eq!(install::bundle_version(&dir.join("Centralu.app")), Some(2));

    // It starts one: the old one goes.
    let r = start_keeper(&resources(2, "two", true), &data, None, false, &Fake::new(started())).unwrap();
    assert!(r.started);
    assert!(!dir.join(".Centralu.app.old").exists());
}

#[test]
fn each_refusal_starts_the_keeper_directly_with_the_shells_reason_shown_in_a_release() {
    for reason in ["usage", "content", "shell-too-old", "downgrade", "copy", "keeper-start", "keeper-exited", "keeper-timeout"] {
        let (res, data) = (resources(1, "one", true), temp("data"));
        let r = start_keeper(&res, &data, None, false, &Fake::new(refused(reason))).unwrap();
        assert_eq!(
            r,
            Report {
                started: false,
                reason: Some(reason.into()),
                message: Some(format!("the shell said {reason}")),
                notify: true,
                shell_version: Some(1)
            }
        );
        let log = fs::read_to_string(data.join("keeper.log")).unwrap();
        assert!(log.contains(&format!("[window] starting the keeper directly ({reason})")), "{log}");
    }
}

#[test]
fn a_shell_that_never_reports_falls_back_visibly() {
    let (res, data) = (resources(1, "one", true), temp("data"));
    let r = start_keeper(&res, &data, None, false, &Fake::new(None)).unwrap();
    assert_eq!((r.started, r.reason.as_deref(), r.notify), (false, Some("no-report"), true));
}

#[test]
fn a_local_build_does_not_install_or_open_its_unpinned_shell_and_only_logs_why() {
    let (res, data) = (resources(1, "local", false), temp("data"));
    let w = Fake::new(refused("content"));
    let r = start_keeper(&res, &data, None, false, &w).unwrap();
    assert_eq!((r.started, r.reason.as_deref(), r.notify), (false, Some("unpinned"), false));
    assert!(w.opened.borrow().is_empty());
    assert!(!install::shell_dir(&data).exists(), "nothing installed");
    assert!(fs::read_to_string(data.join("keeper.log")).unwrap().contains("(unpinned)"));

    // Asked for by hand: installed and opened, and the production shell's refusal of throwaway-signed
    // content stays quiet.
    let r = start_keeper(&res, &data, None, true, &w).unwrap();
    assert_eq!((r.started, r.reason.as_deref(), r.notify), (false, Some("content"), false));
    assert_eq!(w.opened.borrow().len(), 1);
}

#[test]
fn a_build_without_a_shell_starts_directly_and_quietly() {
    let (res, data) = (temp("res"), temp("data"));
    let r = start_keeper(&res, &data, None, false, &Fake::new(started())).unwrap();
    assert_eq!((r.started, r.reason.as_deref(), r.notify), (false, Some("not-carried"), false));
}

#[test]
fn a_shell_that_cannot_be_installed_falls_back_unless_one_is_installed_already() {
    let data = temp("data");
    let res = resources(2, "two", true);
    // The carried bytes no longer match what the release recorded.
    fs::write(res.join("shell/Centralu.app/Contents/MacOS/centralu-shell"), "damaged").unwrap();
    let w = Fake::new(started());
    let r = start_keeper(&res, &data, None, false, &w).unwrap();
    assert_eq!((r.started, r.reason.as_deref(), r.notify), (false, Some("install"), true));
    assert!(w.opened.borrow().is_empty());

    // With shell 1 installed, it is opened instead.
    start_keeper(&resources(1, "one", true), &data, None, false, &Fake::new(started())).unwrap();
    let r = start_keeper(&res, &data, None, false, &w).unwrap();
    assert_eq!((r.started, r.shell_version), (true, Some(1)));
    assert!(fs::read_to_string(data.join("keeper.log")).unwrap().contains("opening the installed shell 1"));
}
