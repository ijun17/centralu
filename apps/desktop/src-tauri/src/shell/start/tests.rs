use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};

/// A world where the keeper, LaunchServices and the status file do what the test says.
#[derive(Default)]
struct Fake {
    /// The keeper answers from this check on (`keeper_alive` calls, counted from 0).
    alive_from: Option<usize>,
    checks: Cell<usize>,
    open_error: Option<String>,
    /// The status file appears after this many reads, with the nonce the window sent (or `foreign`).
    status: Option<(usize, Value)>,
    reads: Cell<usize>,
    opened: RefCell<Vec<(PathBuf, Vec<String>)>>,
    slept: Cell<u32>,
}

impl World for Fake {
    fn keeper_alive(&self) -> bool {
        let n = self.checks.get();
        self.checks.set(n + 1);
        self.alive_from.is_some_and(|from| n >= from)
    }
    fn open_shell(&self, shell_app: &Path, args: &[String]) -> Result<(), String> {
        self.opened.borrow_mut().push((shell_app.to_path_buf(), args.to_vec()));
        self.open_error.clone().map_or(Ok(()), Err)
    }
    fn read_status(&self) -> Option<Value> {
        let n = self.reads.get();
        self.reads.set(n + 1);
        let (after, v) = self.status.as_ref()?;
        if n < *after {
            return None;
        }
        let mut v = v.clone();
        if v.get("nonce").is_none() {
            let nonce = self.opened.borrow().last().and_then(|(_, a)| a.last().cloned());
            v["nonce"] = json!(nonce);
        }
        Some(v)
    }
    fn sleep(&self, _: Duration) {
        self.slept.set(self.slept.get() + 1);
    }
}

fn request() -> Request {
    Request {
        shell_app: PathBuf::from("/Users/a/.centralu/shell/Centralu.app"),
        content: PathBuf::from("/Applications/Centralu.app/Contents/Resources/content"),
        data_dir: PathBuf::from("/Users/a/.centralu"),
        bundle_path: Some("/Applications/Centralu.app".into()),
        nonce: "0123456789abcdef0123456789abcdef".into(),
    }
}

fn refused(reason: &str, message: &str) -> Value {
    json!({ "format": 1, "result": "refused", "reason": reason, "exitCode": 10, "message": message })
}

#[test]
fn a_keeper_answering_opens_no_shell() {
    let w = Fake { alive_from: Some(0), ..Default::default() };
    assert_eq!(start(&request(), &w), Outcome::KeeperAnswering);
    assert!(w.opened.borrow().is_empty());
}

#[test]
fn the_shell_starting_a_keeper_means_no_direct_start() {
    let w = Fake { status: Some((3, json!({ "format": 1, "result": "started", "keeperPid": 42 }))), ..Default::default() };
    assert_eq!(start(&request(), &w), Outcome::Started { reported: true });
    let opened = w.opened.borrow();
    assert_eq!(opened.len(), 1, "opened once");
    assert_eq!(opened[0].0, PathBuf::from("/Users/a/.centralu/shell/Centralu.app"));
    assert_eq!(
        opened[0].1,
        [
            "--content",
            "/Applications/Centralu.app/Contents/Resources/content",
            "--data-dir",
            "/Users/a/.centralu",
            "--bundle-path",
            "/Applications/Centralu.app",
            "--nonce",
            "0123456789abcdef0123456789abcdef"
        ]
    );
}

#[test]
fn every_refusal_falls_back_with_the_shells_reason() {
    for reason in ["usage", "content", "shell-too-old", "downgrade", "copy", "keeper-start", "keeper-exited", "keeper-timeout"] {
        let message = format!("because of {reason}");
        let w = Fake { status: Some((0, refused(reason, &message))), ..Default::default() };
        assert_eq!(start(&request(), &w), Outcome::Fallback(Fallback::new(reason, message)), "{reason}");
    }
}

#[test]
fn a_report_from_another_start_is_not_this_ones() {
    // An old status file (another nonce) and no keeper: the window waits it out, then falls back.
    let mut old = refused("content", "an earlier start");
    old["nonce"] = json!("ffff");
    let w = Fake { status: Some((0, old)), ..Default::default() };
    match start(&request(), &w) {
        Outcome::Fallback(f) => assert_eq!(f.reason, "no-report"),
        other => panic!("{other:?}"),
    }
    assert!(w.slept.get() >= (REPORT_TIMEOUT.as_millis() / POLL.as_millis()) as u32 - 1, "waited the whole timeout");
}

#[test]
fn launch_services_failing_falls_back_at_once() {
    let w = Fake { open_error: Some("LSOpenURLsWithRole() failed with error -10810".into()), ..Default::default() };
    match start(&request(), &w) {
        Outcome::Fallback(f) => {
            assert_eq!(f.reason, "open");
            assert!(f.message.contains("-10810"), "{}", f.message);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(w.slept.get(), 0);
}

#[test]
fn a_keeper_that_answers_without_a_report_counts_as_started_after_a_grace() {
    let w = Fake { alive_from: Some(5), ..Default::default() };
    assert_eq!(start(&request(), &w), Outcome::Started { reported: false });
    let grace = (REPORT_GRACE.as_millis() / POLL.as_millis()) as u32;
    assert!(w.slept.get() >= grace && w.slept.get() < grace + 10, "waited the grace, not the timeout: {}", w.slept.get());
}

#[test]
fn a_report_that_cannot_be_read_falls_back() {
    let w = Fake { status: Some((0, json!({ "format": 1, "result": "maybe" }))), ..Default::default() };
    assert_eq!(start(&request(), &w), Outcome::Fallback(Fallback::new("status", "the shell's report is not one this window can read")));
}

#[test]
fn opens_through_launch_services_without_activating() {
    let (program, args) = open_command(Path::new("/d/shell/Centralu.app"), &["--content".into(), "/c d".into()]);
    assert_eq!(program, PathBuf::from("/usr/bin/open"));
    assert_eq!(args, ["-n", "-g", "-a", "/d/shell/Centralu.app", "--args", "--content", "/c d"]);
}

#[test]
fn a_nonce_is_what_the_shell_accepts() {
    let a = nonce();
    assert_eq!(a.len(), 32);
    assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_ne!(a, nonce());
    let mut r = request();
    r.bundle_path = None;
    assert!(!shell_args(&r).contains(&"--bundle-path".to_string()));
}
