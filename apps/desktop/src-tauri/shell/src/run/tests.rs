//! One start, end to end inside this process: real content signed with a key made here, a stand-in
//! keeper (a shell script listed in that content), and a readiness check the stand-in satisfies by
//! creating a file. scripts/shell-integration.mts runs the real binary with a
//! keeper that answers on a real socket.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use content_verify::{remove_content, TrustedKey, MANIFEST_NAME, SIGNATURE_NAME};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;

const PLATFORM: &str = "test-platform";

/// A stand-in keeper: writes where it runs from and its arguments into `<data>/fake-keeper.out`
/// (the data folder is its third argument, after `--keeper --data-dir`), then marks itself ready.
const READY_KEEPER: &str = "#!/bin/sh\nprintf '%s\\n' \"$0\" \"$@\" > \"$3/fake-keeper.out\"\necho \"keeper output\"\n: > \"$3/fake-ready\"\nexec sleep 2\n";

fn key() -> SigningKey {
    let mut seed = [0u8; 32];
    use std::io::Read;
    fs::File::open("/dev/urandom").unwrap().read_exact(&mut seed).unwrap();
    SigningKey::from_bytes(&seed)
}

fn trusted(k: &SigningKey) -> TrustedKey {
    TrustedKey::from_raw("test", k.verifying_key().as_bytes()).unwrap()
}

struct Temp(PathBuf);
impl Temp {
    fn new(tag: &str) -> Temp {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("cc-shell-run-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = remove_content(&p);
        fs::create_dir_all(&p).unwrap();
        Temp(p)
    }
    fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = remove_content(&self.0);
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Content in `dir`: `files` (path, bytes, executable), with a manifest for `version` signed by `k`.
fn write_content(dir: &Path, version: &str, min_shell: u64, files: &[(&str, Vec<u8>, bool)], k: &SigningKey) {
    let _ = remove_content(dir);
    fs::create_dir_all(dir).unwrap();
    let mut entries = Vec::new();
    let mut sorted: Vec<_> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for (path, bytes, exe) in sorted {
        let p = dir.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, bytes).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(if *exe { 0o755 } else { 0o644 })).unwrap();
        entries.push(json!({ "path": path, "size": bytes.len(), "sha256": hex(&Sha256::digest(bytes)), "executable": exe }));
    }
    let manifest = json!({ "format": 1, "appVersion": version, "platform": PLATFORM, "minShellVersion": min_shell, "files": entries });
    let mut m = serde_json::to_string_pretty(&manifest).unwrap();
    m.push('\n');
    fs::write(dir.join(MANIFEST_NAME), &m).unwrap();
    let sig = json!({
        "format": 1,
        "algorithm": "ed25519",
        "keyId": content_verify::key_id(k.verifying_key().as_bytes()),
        "signature": STANDARD.encode(k.sign(m.as_bytes()).to_bytes()),
    });
    fs::write(dir.join(SIGNATURE_NAME), serde_json::to_string_pretty(&sig).unwrap()).unwrap();
}

fn files(keeper: &str) -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![
        ("centralu-keeper", keeper.as_bytes().to_vec(), true),
        ("host/main.mjs", b"// the host\n".to_vec(), false),
        ("host/bundle-info.json", br#"{"commit":"abc1234"}"#.to_vec(), false),
    ]
}

struct Case {
    t: Temp,
    k: SigningKey,
}

impl Case {
    fn new(tag: &str) -> Case {
        let t = Temp::new(tag);
        fs::create_dir_all(t.join("data")).unwrap();
        let k = key();
        write_content(&t.join("src"), "0.2.0", 1, &files(READY_KEEPER), &k);
        Case { t, k }
    }
    fn data(&self) -> PathBuf {
        self.t.join("data")
    }
    fn args(&self) -> Args {
        Args { content: self.t.join("src"), data_dir: self.data(), bundle_path: Some("/Applications/Centralu.app".into()), nonce: None, rollback: false }
    }
    fn env(&self) -> Env {
        let ready = self.data().join("fake-ready");
        Env {
            keys: vec![trusted(&self.k)],
            platform: PLATFORM.into(),
            shell_version: 1,
            ready_timeout: Duration::from_secs(20),
            alive: Box::new(move |_| ready.exists()),
        }
    }
    fn run(&self) -> Result<Started, Refusal> {
        let r = run(&self.args(), &self.env());
        // The next start in the same case begins with no keeper answering.
        let _ = fs::remove_file(self.data().join("fake-ready"));
        r
    }
    fn keeper_run(&self) -> Option<Vec<String>> {
        let out = fs::read_to_string(self.data().join("fake-keeper.out")).ok()?;
        let _ = fs::remove_file(self.data().join("fake-keeper.out"));
        Some(out.lines().map(String::from).collect())
    }
    fn refused(&self) -> Refusal {
        let r = self.run().expect_err("the start was not refused");
        assert!(self.keeper_run().is_none(), "a refused start ran a keeper ({r:?})");
        r
    }
}

#[test]
fn starts_the_keeper_from_the_verified_copy_with_the_windows_command_line() {
    let c = Case::new("start");
    let s = c.run().unwrap();
    let dest = c.data().join("content/0.2.0");
    assert_eq!(s.content_dir.as_deref(), Some(dest.as_path()));
    assert_eq!(s.app_version.as_deref(), Some("0.2.0"));
    assert!(!s.already_running);
    let ran = c.keeper_run().expect("the keeper ran");
    assert_eq!(ran[0], dest.join("centralu-keeper").to_string_lossy(), "the keeper ran from the copy, not from the source");
    let data = c.data().to_string_lossy().to_string();
    let host = dest.join("host").to_string_lossy().to_string();
    assert_eq!(
        ran[1..],
        ["--keeper", "--data-dir", &data, "--host-source", &host, "--bundle-path", "/Applications/Centralu.app", "--app-version", "0.2.0"]
    );
    // Its output went to keeper.log, after the shell's own lines.
    let log = fs::read_to_string(c.data().join("keeper.log")).unwrap();
    assert!(log.contains("[shell] shell 1"), "{log}");
    assert!(log.contains("verified and copied 3 files"), "{log}");
    wait_for(|| fs::read_to_string(c.data().join("keeper.log")).unwrap().contains("keeper output"));
    assert_eq!(fs::read_to_string(floor_path(&c.data())).unwrap().trim(), "0.2.0", "the floor rose to what started");
    // Read-only, as copied.
    assert_eq!(fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o555);
}

fn wait_for(f: impl Fn() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out");
}

#[test]
fn a_second_start_of_the_same_version_uses_the_copy_once_it_verifies_again() {
    let c = Case::new("again");
    c.run().unwrap();
    c.keeper_run().unwrap();
    let dest = c.data().join("content/0.2.0");
    let inode = |p: &Path| std::os::unix::fs::MetadataExt::ino(&fs::metadata(p).unwrap());
    let before = inode(&dest);
    c.run().unwrap();
    assert_eq!(inode(&dest), before, "the same copy");
    assert!(fs::read_to_string(c.data().join("keeper.log")).unwrap().contains("verifies; starting from it"));
    c.keeper_run().unwrap();

    // A copy changed since is replaced by a fresh one, and the keeper runs from that.
    fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(dest.join("host"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(dest.join("host/main.mjs"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(dest.join("host/main.mjs"), b"// something else\n").unwrap();
    c.run().unwrap();
    assert_ne!(inode(&dest), before, "a new copy");
    assert_eq!(fs::read(dest.join("host/main.mjs")).unwrap(), b"// the host\n");
    assert!(fs::read_to_string(c.data().join("keeper.log")).unwrap().contains("does not verify"));
    assert_eq!(c.keeper_run().unwrap()[0], dest.join("centralu-keeper").to_string_lossy());
}

#[test]
fn a_keeper_already_answering_means_nothing_is_verified_copied_or_started() {
    let c = Case::new("running");
    let mut env = c.env();
    env.alive = Box::new(|_| true);
    // Even content that would be refused: nothing is looked at.
    fs::write(c.t.join("src/host/main.mjs"), b"tampered").unwrap();
    let s = run(&c.args(), &env).unwrap();
    assert!(s.already_running);
    assert_eq!(s.content_dir, None);
    assert!(!c.data().join("content").exists());
    assert!(c.keeper_run().is_none());
}

#[test]
fn content_that_is_not_what_was_signed_is_refused_and_nothing_runs() {
    type Spoil = fn(&Case);
    let spoils: Vec<(&str, Spoil)> = vec![
        ("a listed file changed after signing", |c| fs::write(c.t.join("src/host/main.mjs"), b"// changed\n").unwrap()),
        ("the keeper changed after signing", |c| fs::write(c.t.join("src/centralu-keeper"), "#!/bin/sh\nexit 0\n").unwrap()),
        ("signed by a key the shell does not trust", |c| write_content(&c.t.join("src"), "0.2.0", 1, &files(READY_KEEPER), &key())),
        ("no signature", |c| fs::remove_file(c.t.join("src").join(SIGNATURE_NAME)).unwrap()),
        ("no content folder", |c| remove_content(&c.t.join("src")).unwrap()),
        ("no keeper listed", |c| {
            let mut f = files(READY_KEEPER);
            f.remove(0);
            write_content(&c.t.join("src"), "0.2.0", 1, &f, &c.k)
        }),
        ("a keeper that is not executable", |c| {
            let mut f = files(READY_KEEPER);
            f[0].2 = false;
            write_content(&c.t.join("src"), "0.2.0", 1, &f, &c.k)
        }),
        ("no host", |c| {
            let mut f = files(READY_KEEPER);
            f.remove(1);
            write_content(&c.t.join("src"), "0.2.0", 1, &f, &c.k)
        }),
    ];
    for (what, spoil) in spoils {
        let c = Case::new("content");
        spoil(&c);
        let r = c.refused();
        assert_eq!(r.reason, Reason::Content, "{what}: {r:?}");
        assert_eq!(r.reason.exit_code(), 10);
        assert!(!c.data().join("content/0.2.0").exists(), "{what}: a copy was left in place");
    }
}

#[test]
fn content_for_another_platform_is_refused() {
    let c = Case::new("platform");
    let mut env = c.env();
    env.platform = "darwin-x64".into();
    let r = run(&c.args(), &env).unwrap_err();
    assert_eq!(r.reason, Reason::Content);
    assert!(r.message.contains("darwin-x64"), "{}", r.message);
}

#[test]
fn content_that_needs_a_newer_shell_is_refused_with_its_own_reason() {
    let c = Case::new("shell");
    write_content(&c.t.join("src"), "0.2.0", 2, &files(READY_KEEPER), &c.k);
    let r = c.refused();
    assert_eq!(r.reason, Reason::ShellTooOld);
    assert_eq!(r.reason.exit_code(), 11);
    assert!(r.message.contains("version 2"), "{}", r.message);
}

#[test]
fn an_older_version_than_one_that_ran_is_refused_unless_rolled_back_on_purpose() {
    let c = Case::new("downgrade");
    c.run().unwrap();
    c.keeper_run().unwrap();
    write_content(&c.t.join("src"), "0.1.9", 1, &files(READY_KEEPER), &c.k);
    let r = c.refused();
    assert_eq!(r.reason, Reason::Downgrade);
    assert_eq!(r.reason.exit_code(), 12);
    assert!(r.message.contains("0.1.9 is older than 0.2.0"), "{}", r.message);
    assert!(!c.data().join("content/0.1.9").exists(), "nothing was copied");

    let mut a = c.args();
    a.rollback = true;
    let s = run(&a, &c.env()).unwrap();
    assert_eq!(s.app_version.as_deref(), Some("0.1.9"));
    assert_eq!(fs::read_to_string(floor_path(&c.data())).unwrap().trim(), "0.1.9", "a rollback sets the floor to what it chose");
    assert!(c.keeper_run().is_some());
    // A prerelease of the same version is older too.
    let _ = fs::remove_file(c.data().join("fake-ready"));
    write_content(&c.t.join("src"), "0.1.9-beta.1", 1, &files(READY_KEEPER), &c.k);
    assert_eq!(c.refused().reason, Reason::Downgrade);
}

#[test]
fn an_unreadable_floor_does_not_stop_a_start() {
    let c = Case::new("floor");
    fs::create_dir_all(c.data().join("content")).unwrap();
    fs::write(floor_path(&c.data()), "not a version\n").unwrap();
    c.run().unwrap();
    assert_eq!(fs::read_to_string(floor_path(&c.data())).unwrap().trim(), "0.2.0");
}

#[test]
fn a_data_folder_that_does_not_exist_is_refused_and_not_created() {
    let c = Case::new("nodata");
    fs::remove_dir(c.data()).unwrap();
    let r = c.run().unwrap_err();
    assert_eq!(r.reason, Reason::Usage, "{r:?}");
    assert!(r.message.contains("does not exist"), "{}", r.message);
    assert!(!c.data().exists(), "the shell created the data folder the window owns");
}

#[test]
fn content_inside_the_folder_the_shell_copies_into_is_refused() {
    let c = Case::new("inside");
    c.run().unwrap();
    c.keeper_run().unwrap();
    let copy = c.data().join("content/0.2.0");
    // Directly, through a symlink, and a folder there that does not exist (yet). `..` never gets
    // here (`args`).
    let link = c.t.join("link");
    std::os::unix::fs::symlink(&copy, &link).unwrap();
    for content in [copy.clone(), link, c.data().join("content/0.3.0")] {
        let mut a = c.args();
        a.content = content.clone();
        let r = run(&a, &c.env()).unwrap_err();
        assert_eq!(r.reason, Reason::Usage, "{}: {r:?}", content.display());
        assert!(c.keeper_run().is_none());
    }
    assert!(verify_in_place(&copy, &c.env().keys, &Expect { platform: PLATFORM.into(), shell_version: Some(1) }).is_ok(), "the copy was left alone");
}

#[test]
fn a_data_folder_that_cannot_hold_the_copy_is_a_copy_refusal() {
    let c = Case::new("copy");
    fs::write(c.data().join("content"), b"a file where the folder goes").unwrap();
    let r = c.refused();
    assert_eq!(r.reason, Reason::Copy, "{r:?}");
    assert_eq!(r.reason.exit_code(), 13);
}

#[test]
fn a_keeper_that_cannot_start_exits_or_never_answers_is_refused() {
    let cases: [(&str, Reason, u64); 3] = [
        ("#!/nonexistent/interpreter\n", Reason::KeeperStart, 20),
        ("#!/bin/sh\necho 'no store' >&2\nexit 1\n", Reason::KeeperExited, 20),
        ("#!/bin/sh\necho $$ > \"$3/fake-pid\"\nexec sleep 30\n", Reason::KeeperTimeout, 1),
    ];
    for (script, reason, timeout) in cases {
        let c = Case::new("keeper");
        write_content(&c.t.join("src"), "0.2.0", 1, &files(script), &c.k);
        let mut env = c.env();
        env.ready_timeout = Duration::from_secs(timeout);
        let began = std::time::Instant::now();
        let r = run(&c.args(), &env).unwrap_err();
        // Within the timeout and a margin, not the 30 s the stand-in would take to end by itself.
        assert!(began.elapsed() < Duration::from_secs(timeout + 10), "{script}: took {:?}", began.elapsed());
        assert_eq!(r.reason, reason, "{script}: {r:?}");
        assert!(!fs::read_to_string(floor_path(&c.data())).map(|s| s.contains("0.2.0")).unwrap_or(false), "a failed start raised the floor");
        if reason == Reason::KeeperExited {
            assert!(r.message.contains("exit code 1"), "{}", r.message);
            wait_for(|| fs::read_to_string(c.data().join("keeper.log")).unwrap().contains("no store"));
        }
        if reason == Reason::KeeperTimeout {
            // The keeper it started and gave up on is stopped, so the window's own start is not kept
            // waiting for the lock.
            let pid: i32 = fs::read_to_string(c.data().join("fake-pid")).unwrap().trim().parse().unwrap();
            assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "the keeper that never answered still runs");
        }
    }
}

/// On an update the keeper this shell started verifies and copies the next content into the same
/// `<data>/content/` itself, removes the versions nothing uses and raises the same floor (thin-shell
/// plan §10 step 5): both must name the folder, the floor and the host alike.
#[test]
fn the_shell_and_the_keeper_lay_out_the_content_folder_alike() {
    use centralu_keeper_core::keeper::content;
    assert_eq!(CONTENT_DIR, content::CONTENT_DIR);
    assert_eq!(FLOOR_FILE, content::FLOOR_FILE);
    assert_eq!(HOST_DIR, content::HOST_DIR);
    assert_eq!(floor_path(Path::new("/d")), content::floor_path(Path::new("/d")));
}
