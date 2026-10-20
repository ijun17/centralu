//! The keeper's decisions about verified content, without a keeper: where it runs from, what a
//! handoff refuses, where it copies, and what the cleanup removes. Content is signed here with a key
//! made for the test; scripts/keeper-content-integration.mts runs the real handoff.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use content_verify::{hex, remove_content, TrustedKey, MANIFEST_NAME, SIGNATURE_NAME};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::keeper::source::{BuildSource, Copies};

const PLATFORM: &str = "test-platform";

fn key() -> SigningKey {
    SigningKey::from_bytes(&crate::os::random_bytes::<32>().unwrap())
}

fn trusted(k: &SigningKey) -> TrustedKey {
    TrustedKey::from_raw("test", k.verifying_key().as_bytes()).unwrap()
}

struct Temp(PathBuf);
impl Temp {
    fn new(tag: &str) -> Temp {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("cc-keeper-content-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Content in `dir`: `files` (path, bytes, executable), with a manifest for `version` signed by `k`.
fn write_content(dir: &Path, version: &str, files: &[(&str, Vec<u8>, bool)], k: &SigningKey) {
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
    let manifest = json!({ "format": 1, "appVersion": version, "platform": PLATFORM, "minShellVersion": 1, "files": entries });
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

fn files(version: &str) -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![
        (KEEPER_EXE, format!("#!/bin/sh\n# keeper {version}\n").into_bytes(), true),
        ("host/main.mjs", format!("// the host of {version}\n").into_bytes(), false),
        ("host/bundle-info.json", format!(r#"{{"commit":"c-{version}"}}"#).into_bytes(), false),
    ]
}

/// A data folder and a signing key, with `content` laid out as the window's bundle carries it.
struct Case {
    t: Temp,
    k: SigningKey,
    keys: Vec<TrustedKey>,
    lines: std::sync::Mutex<Vec<String>>,
}

impl Case {
    fn new(tag: &str) -> Case {
        let t = Temp::new(tag);
        fs::create_dir_all(t.join("data")).unwrap();
        let k = key();
        let keys = vec![trusted(&k)];
        Case { t, k, keys, lines: Default::default() }
    }
    fn data(&self) -> PathBuf {
        self.t.join("data")
    }
    /// `<bundle>/Contents/Resources/content` for `version`, signed by this case's key.
    fn bundle(&self, name: &str, version: &str) -> PathBuf {
        let src = self.t.join(&format!("{name}.app/Contents/Resources/content"));
        write_content(&src, version, &files(version), &self.k);
        src
    }
    fn verify<T>(&self, f: impl FnOnce(&Verifier) -> T) -> T {
        let log = |m: &str| self.lines.lock().unwrap().push(m.to_string());
        f(&Verifier { keys: &self.keys, platform: PLATFORM.into(), log: &log })
    }
    fn check(&self, src: &Path) -> Result<(Manifest, Vec<u8>), Refusal> {
        self.verify(|v| v.check(&self.data(), src))
    }
    /// `check`, then `place` with nothing in use.
    fn take(&self, src: &Path) -> Result<PathBuf, Refusal> {
        self.take_in_use(src, false)
    }
    fn take_in_use(&self, src: &Path, in_use: bool) -> Result<PathBuf, Refusal> {
        let (m, bytes) = self.check(src)?;
        self.verify(|v| v.place(&self.data(), src, &m, &bytes, in_use))
    }
}

// ---- where the keeper runs from

#[test]
fn a_keeper_in_a_verified_copy_runs_from_content_and_any_other_runs_directly() {
    let c = Case::new("origin");
    let data = c.data();
    let dir = version_dir(&data, "0.2.0");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(KEEPER_EXE), "k").unwrap();
    assert_eq!(origin_of(&dir.join(KEEPER_EXE), &data), Origin::Content { dir: dir.clone(), version: "0.2.0".into(), signed: false });
    assert_eq!(origin_of(&dir.join(KEEPER_EXE), &data).dir(), Some(dir.as_path()));

    // The window's bundle, a build folder, the window's own executable in-process
    for exe in [
        c.t.join("A.app/Contents/MacOS/centralu-keeper"),
        c.t.join("target/debug/centralu-keeper"),
        dir.join("centralu"),
    ] {
        assert_eq!(origin_of(&exe, &data), Origin::Direct, "{}", exe.display());
    }
    // Not a version folder, deeper than one, another data folder's content
    let odd = content_root(&data).join("not-a-version");
    fs::create_dir_all(&odd).unwrap();
    assert_eq!(origin_of(&odd.join(KEEPER_EXE), &data), Origin::Direct);
    assert_eq!(origin_of(&dir.join("host").join(KEEPER_EXE), &data), Origin::Direct);
    assert_eq!(origin_of(&dir.join(KEEPER_EXE), &c.t.join("other-data")), Origin::Direct);
}

/// `/tmp` is a symlink on macOS: the keeper's own path comes back resolved while the data folder
/// it was given may not be, and the other way round.
#[test]
fn the_origin_holds_through_a_symlinked_data_folder() {
    let c = Case::new("origin-link");
    let data = c.data();
    let dir = version_dir(&data, "0.2.0");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(KEEPER_EXE), "k").unwrap();
    let link = c.t.join("data-link");
    std::os::unix::fs::symlink(&data, &link).unwrap();
    assert_eq!(
        origin_of(&dir.join(KEEPER_EXE), &link),
        Origin::Content { dir: version_dir(&link, "0.2.0"), version: "0.2.0".into(), signed: false },
        "the folder is spelled from the data folder as given"
    );
    assert!(matches!(origin_of(&version_dir(&link, "0.2.0").join(KEEPER_EXE), &data), Origin::Content { .. }));
}

#[test]
fn a_host_in_verified_content_is_found_by_its_version_folder() {
    let c = Case::new("host-dir");
    let data = c.data();
    assert_eq!(version_dir_of(&data, &version_dir(&data, "0.2.0").join("host")), Some(version_dir(&data, "0.2.0")));
    assert_eq!(version_dir_of(&data, &data.join("hosts/abc1234")), None);
    assert_eq!(version_dir_of(&data, &version_dir(&data, "0.2.0").join("host/sub")), None);
    assert_eq!(version_dir_of(&data, &version_dir(&data, "0.2.0")), None);
    assert_eq!(version_dir_of(&data, &content_root(&data).join("x/host")), None);
    assert_eq!(version_dir_of(&data, Path::new("/Applications/Centralu.app/Contents/Resources/resources/host")), None);
}

#[test]
fn the_new_bundle_content_is_found_from_the_executable_the_window_names() {
    let want = Some(PathBuf::from("/Applications/Centralu.app/Contents/Resources/content"));
    assert_eq!(bundle_content_of_exe(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu-keeper")), want);
    // A window from before #440 named its own executable, beside it: no longer a keeper (#461)
    assert_eq!(bundle_content_of_exe(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu")), None);
    assert_eq!(bundle_content_of_exe(Path::new("/tmp/build/centralu-keeper")), None, "not in a bundle");
    assert_eq!(bundle_content_of_bundle(Path::new("/Applications/Centralu.app")), want.unwrap());
}

// ---- what a handoff refuses

#[test]
fn signed_content_is_copied_read_only_into_its_version_folder() {
    let c = Case::new("copy");
    let src = c.bundle("B", "0.2.1");
    let dest = c.take(&src).unwrap();
    assert_eq!(dest, version_dir(&c.data(), "0.2.1"));
    assert_eq!(fs::read(dest.join(KEEPER_EXE)).unwrap(), fs::read(src.join(KEEPER_EXE)).unwrap());
    assert!(dest.join(MANIFEST_NAME).is_file() && dest.join(SIGNATURE_NAME).is_file(), "the copy can be verified again");
    assert_eq!(fs::metadata(&dest).unwrap().permissions().mode() & 0o222, 0, "read-only");
    assert_eq!(fs::metadata(dest.join("host/main.mjs")).unwrap().permissions().mode() & 0o222, 0);
}

#[test]
fn a_bundle_with_no_content_is_refused() {
    let c = Case::new("none");
    assert_eq!(c.check(&c.t.join("Old.app/Contents/Resources/content")).unwrap_err().reason, "no-content");
}

#[test]
fn content_signed_with_a_key_this_build_does_not_trust_is_refused() {
    let c = Case::new("key");
    let src = c.t.join("X.app/Contents/Resources/content");
    write_content(&src, "0.2.1", &files("0.2.1"), &key());
    let r = c.check(&src).unwrap_err();
    assert_eq!(r.reason, "content");
    assert!(r.message.contains("not what the project signed") && r.message.contains("unknown key"), "{}", r.message);
    // The window words the check, not the sentence
    assert_eq!((r.check, r.file), (Some("unknown-key"), None));
    assert!(!version_dir(&c.data(), "0.2.1").exists());
}

/// The manifest verifies; a file it lists does not. Found while copying, and nothing is left.
#[test]
fn content_changed_after_signing_is_refused_and_nothing_is_left_behind() {
    let c = Case::new("tamper");
    let src = c.bundle("X", "0.2.2");
    fs::write(src.join("host/main.mjs"), "// not what was signed\n").unwrap();
    let r = c.take(&src).unwrap_err();
    assert_eq!(r.reason, "content", "{r}");
    assert!(r.message.contains("host/main.mjs"), "{}", r.message);
    // A file of another size: which file, and the sizes
    assert_eq!((r.check, r.file.as_deref()), (Some("size-mismatch"), Some("host/main.mjs")));
    assert!(r.message.contains("bytes, the manifest says"), "{}", r.message);
    assert!(!version_dir(&c.data(), "0.2.2").exists());
    let left: Vec<_> = fs::read_dir(content_root(&c.data())).unwrap().flatten().map(|e| e.file_name()).collect();
    assert!(left.is_empty(), "no partial copy is left: {left:?}");
}

/// The same size and other bytes: the hash says it, and the refusal carries both hashes in full.
#[test]
fn a_file_of_the_same_size_with_other_bytes_is_refused_with_both_hashes() {
    let c = Case::new("same-size");
    let src = c.bundle("X", "0.2.2");
    let mut bytes = fs::read(src.join("host/main.mjs")).unwrap();
    bytes[0] ^= 1;
    fs::write(src.join("host/main.mjs"), &bytes).unwrap();
    let r = c.take(&src).unwrap_err();
    assert_eq!((r.reason, r.check, r.file.as_deref()), ("content", Some("hash-mismatch"), Some("host/main.mjs")));
    assert!(r.message.contains("the signed manifest lists") && r.message.contains(", the file is "), "{}", r.message);
    let found = r.message.rsplit(", the file is ").next().unwrap();
    assert_eq!(found.len(), 64, "the file's hash, in full: {found}");
    assert_eq!(found, content_verify::sha256_file(&src.join("host/main.mjs")).unwrap());
    let (m, _) = c.check(&src).unwrap();
    let listed = m.files.iter().find(|f| f.path == "host/main.mjs").unwrap();
    assert!(r.message.contains(&hex(&listed.sha256)), "the manifest's hash: {}", r.message);
    assert!(!version_dir(&c.data(), "0.2.2").exists());
}

#[test]
fn content_for_another_platform_is_refused() {
    let c = Case::new("platform");
    let src = c.bundle("X", "0.2.1");
    let (m, _) = c.check(&src).unwrap();
    assert_eq!(m.platform, PLATFORM);
    let log = |_: &str| ();
    let other = Verifier { keys: &c.keys, platform: "linux-x64".into(), log: &log };
    let r = other.check(&c.data(), &src).unwrap_err();
    assert_eq!(r.reason, "content");
    assert!(r.message.contains("linux-x64"), "{}", r.message);
    assert_eq!(r.check, Some("wrong-platform"));
}

#[test]
fn content_with_no_keeper_or_no_host_is_refused() {
    let c = Case::new("runnable");
    let src = c.t.join("X.app/Contents/Resources/content");
    let mut no_exec = files("0.2.1");
    no_exec[0].2 = false;
    write_content(&src, "0.2.1", &no_exec, &c.k);
    assert!(c.check(&src).unwrap_err().message.contains("no executable centralu-keeper"));
    write_content(&src, "0.2.1", &files("0.2.1")[..1], &c.k);
    assert!(c.check(&src).unwrap_err().message.contains("no host/main.mjs"));
}

/// The shell's rule: a lower version than one that already ran here starts only on purpose, and a
/// handoff is never on purpose (the rollback goes through the shell).
#[test]
fn an_older_version_than_the_floor_is_refused_and_the_same_or_newer_is_not() {
    let c = Case::new("floor");
    fs::create_dir_all(content_root(&c.data())).unwrap();
    fs::write(floor_path(&c.data()), "0.2.1\n").unwrap();
    let r = c.check(&c.bundle("Old", "0.2.0")).unwrap_err();
    assert_eq!(r.reason, "downgrade");
    assert!(r.message.contains("0.2.0 is older than 0.2.1"), "{}", r.message);
    assert_eq!(r.check, Some("downgrade"));
    assert!(c.check(&c.bundle("Same", "0.2.1")).is_ok());
    assert!(c.check(&c.bundle("New", "0.3.0-beta.1")).is_ok());
}

#[test]
fn an_unreadable_floor_is_said_and_ignored() {
    let c = Case::new("bad-floor");
    fs::create_dir_all(content_root(&c.data())).unwrap();
    fs::write(floor_path(&c.data()), "not a version\n").unwrap();
    assert!(c.check(&c.bundle("X", "0.1.0")).is_ok());
    assert!(c.lines.lock().unwrap().iter().any(|l| l.contains("ignoring an unreadable")));
}

#[test]
fn content_from_inside_the_content_folder_is_refused() {
    let c = Case::new("inside");
    let src = c.bundle("X", "0.2.1");
    let dest = c.take(&src).unwrap();
    assert_eq!(c.check(&dest).unwrap_err().reason, "content");
}

// ---- where it goes

/// A restart of the same release must not copy it again, nor trust a folder that changed.
#[test]
fn a_version_already_there_is_reused_when_it_verifies_and_copied_again_when_not() {
    let c = Case::new("reuse");
    let src = c.bundle("B", "0.2.1");
    let dest = c.take(&src).unwrap();
    use std::os::unix::fs::MetadataExt;
    let inode = fs::metadata(dest.join(KEEPER_EXE)).unwrap().ino();
    assert_eq!(c.take(&src).unwrap(), dest);
    assert_eq!(fs::metadata(dest.join(KEEPER_EXE)).unwrap().ino(), inode, "reused, not copied again");

    // Someone of this user changed the copy: it is replaced, from the signed source
    fs::set_permissions(dest.join("host"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(dest.join("host/main.mjs"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(dest.join("host/main.mjs"), "// changed\n").unwrap();
    assert_eq!(c.take(&src).unwrap(), dest);
    assert_eq!(fs::read_to_string(dest.join("host/main.mjs")).unwrap(), "// the host of 0.2.1\n");
}

/// The folder a keeper or host runs from is never removed under it: an update that would have to
/// replace it is refused instead.
#[test]
fn a_version_folder_in_use_that_does_not_verify_is_refused_and_left_alone() {
    let c = Case::new("in-use");
    let src = c.bundle("B", "0.2.1");
    let dest = c.take(&src).unwrap();
    fs::set_permissions(dest.join("host"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(dest.join("host/main.mjs"), fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(dest.join("host/main.mjs"), "// running\n").unwrap();
    let r = c.take_in_use(&src, true).unwrap_err();
    assert_eq!(r.reason, "in-use", "{r}");
    assert_eq!(fs::read_to_string(dest.join("host/main.mjs")).unwrap(), "// running\n", "nothing that runs was touched");
    // In use and verifying: taken as it is
    let fresh = c.bundle("C", "0.2.2");
    let d2 = c.take(&fresh).unwrap();
    assert_eq!(c.take_in_use(&fresh, true).unwrap(), d2);
}

// ---- what the cleanup removes

#[test]
fn the_cleanup_names_unused_versions_and_old_partial_copies_and_nothing_else() {
    let entries: Vec<(String, bool)> = [
        ("0.2.0", true),
        ("0.2.1", true),
        ("0.3.0-beta.2", true),
        (".0.2.2.partial-12-ab-0", true),
        (".0.2.3.partial-13-cd-0", true),
        ("highest-started", false),
        ("highest-started.tmp-12", false),
        ("notes", true),
        ("0.1.0", false),
    ]
    .iter()
    .map(|(n, d)| (n.to_string(), *d))
    .collect();
    let keep = vec!["0.2.1".to_string()];
    let mut stale = stale_content(&entries, &keep, &|n: &str| n.contains("0.2.2"));
    stale.sort();
    assert_eq!(stale, [".0.2.2.partial-12-ab-0", "0.2.0", "0.3.0-beta.2"]);
}

/// Sets a path's modification time `secs` into the past.
fn age(path: &Path, secs: i64) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let t = libc::timeval { tv_sec: (now - secs) as libc::time_t, tv_usec: 0 };
    let c = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: a valid C string and two valid timevals.
    assert_eq!(unsafe { libc::utimes(c.as_ptr(), [t, t].as_ptr()) }, 0);
}

/**
 * The claims of `source::Copies` over `content/`: a host from verified content runs where it is (no
 * copy in `hosts/`), and the cleanup removes every version no claim holds, that is not the keeper's
 * own and that no host in use runs from, plus leftover partial copies; never the floor.
 */
#[test]
fn the_cleanup_keeps_the_keepers_own_the_running_hosts_and_the_claimed_versions() {
    let c = Case::new("clean");
    let data = c.data();
    let mut dirs = std::collections::HashMap::new();
    for v in ["0.1.0", "0.2.0", "0.2.1", "0.2.2", "0.3.0"] {
        dirs.insert(v, c.take(&c.bundle(&format!("v{v}"), v)).unwrap());
    }
    fs::write(floor_path(&data), "0.3.0\n").unwrap();
    let dead = content_root(&data).join(".0.4.0.partial-1-a-0");
    let fresh = content_root(&data).join(".0.4.1.partial-2-b-0");
    fs::create_dir_all(&dead).unwrap();
    fs::create_dir_all(&fresh).unwrap();
    age(&dead, 3600);

    // The keeper runs from 0.2.1, its host from 0.2.0, a swap or handoff holds 0.3.0
    let copies = Copies::new(&data, Some(dirs["0.2.1"].clone()));
    let host = BuildSource { commit: "c".into(), host_dir: Some(dirs["0.3.0"].join("host").to_string_lossy().into()), ..Default::default() };
    let held = copies.claim(&host).unwrap();
    assert_eq!(held.path(), dirs["0.3.0"].join("host"), "a verified host runs where it is");
    assert_eq!(held.folder(), dirs["0.3.0"]);
    assert!(!data.join("hosts").exists(), "and is never copied into hosts/");

    let mut removed = copies.clean(|| vec![dirs["0.2.0"].join("host")]);
    removed.sort();
    assert_eq!(removed, ["content/.0.4.0.partial-1-a-0", "content/0.1.0", "content/0.2.2"]);
    for v in ["0.2.0", "0.2.1", "0.3.0"] {
        assert!(dirs[v].join(KEEPER_EXE).is_file(), "{v} is in use and kept");
    }
    assert!(fresh.is_dir(), "a copy being written now is not a leftover");
    assert!(floor_path(&data).is_file(), "the floor stays");

    // Given up, and with no host on it any more, a version goes like any other
    drop(held);
    let mut removed = copies.clean(|| vec![dirs["0.2.1"].join("host")]);
    removed.sort();
    assert_eq!(removed, ["content/0.2.0", "content/0.3.0"]);
    assert!(dirs["0.2.1"].is_dir(), "the keeper's own folder is never removed");
}

/// A swap whose verified build did not start gives its folder up without removing it: it may be
/// the folder the keeper itself runs from.
#[test]
fn discarding_a_claim_on_verified_content_leaves_the_folder() {
    let c = Case::new("discard");
    let dir = c.take(&c.bundle("B", "0.2.1")).unwrap();
    let copies = Copies::new(&c.data(), None);
    let src = BuildSource { commit: "c".into(), host_dir: Some(dir.join("host").to_string_lossy().into()), ..Default::default() };
    copies.claim(&src).unwrap().discard(None);
    assert!(dir.join("host/main.mjs").is_file());
}

/// A handoff places its version under the same lock as every cleanup, and is told whether the
/// folder is in use: claimed, the keeper's own, or a running host's.
#[test]
fn placing_a_version_knows_whether_it_is_in_use() {
    let c = Case::new("claim-content");
    let data = c.data();
    let own = version_dir(&data, "0.2.0");
    let copies = Copies::new(&data, Some(own.clone()));
    let seen = |folder: &Path, running: &[PathBuf]| -> bool {
        let mut in_use = None;
        let claim = copies.claim_content(folder, running, || "frozen", |u| {
            in_use = Some(u);
            Ok(folder.to_path_buf())
        });
        drop(claim);
        in_use.unwrap()
    };
    let next = version_dir(&data, "0.2.1");
    assert!(seen(&own, &[]), "the keeper's own");
    assert!(!seen(&next, &[]), "nothing runs from it");
    assert!(seen(&next, &[next.join("host")]), "a host runs from it");
    let claim = copies.claim_content(&next, &[], || "frozen", |_| Ok(next.clone())).unwrap();
    assert_eq!(claim.path(), next.join("host"));
    assert!(seen(&next, &[]), "a handoff holds it");
    drop(claim);
    copies.freeze(std::time::Duration::from_secs(1)).unwrap();
    assert_eq!(copies.claim_content(&next, &[], || "frozen", |_| Ok(next.clone())).err(), Some("frozen"));
}

// ---- why the window's own content would be refused

/// After the shell refuses, the window reads the content again to say which file or check failed.
#[test]
fn the_window_can_find_why_its_own_content_would_be_refused_without_running_or_copying_it() {
    let c = Case::new("diagnose");
    let diagnose = |src: &Path| c.verify(|v| diagnose_with(v, &c.data(), src));

    // Whole and signed: nothing to say
    let good = c.bundle("Good", "0.2.0");
    assert_eq!(diagnose(&good), None);

    // A file changed after signing: which file, and what is wrong with it
    let changed = c.bundle("Changed", "0.2.1");
    fs::write(changed.join("host/main.mjs"), "// not what was signed\n").unwrap();
    let r = diagnose(&changed).expect("a file that does not match");
    assert_eq!((r.reason, r.check, r.file.as_deref()), ("content", Some("size-mismatch"), Some("host/main.mjs")));
    assert!(r.message.contains("bytes, the manifest says"), "{}", r.message);

    // Same size, other bytes: the hash says it, with both hashes
    let same_size = c.bundle("Same", "0.2.2");
    let mut other = fs::read(same_size.join("host/main.mjs")).unwrap();
    other[0] ^= 1;
    fs::write(same_size.join("host/main.mjs"), &other).unwrap();
    let r = diagnose(&same_size).expect("a hash that differs");
    assert_eq!((r.check, r.file.as_deref()), (Some("hash-mismatch"), Some("host/main.mjs")));
    assert!(r.message.contains(&content_verify::sha256_file(&same_size.join("host/main.mjs")).unwrap()), "{}", r.message);
    assert!(r.message.contains("the signed manifest lists "), "{}", r.message);
    // The two hashes travel as fields, for the window to show only if they are hex
    let (listed, has) = r.hashes.clone().expect("both hashes");
    assert_eq!(has, content_verify::sha256_file(&same_size.join("host/main.mjs")).unwrap());
    assert_ne!(listed, has);
    assert!(listed.len() == 64 && listed.bytes().all(|b| b.is_ascii_hexdigit()));

    // A listed file that is gone
    let gone = c.bundle("Gone", "0.2.3");
    fs::remove_file(gone.join("host/main.mjs")).unwrap();
    let r = diagnose(&gone).expect("a file that is gone");
    assert_eq!((r.check, r.file.as_deref()), (Some("file-unreadable"), Some("host/main.mjs")));

    // A listed file that is a symlink, or longer than listed, is not read through or to its end
    let link = c.bundle("Link", "0.2.5");
    fs::remove_file(link.join("host/main.mjs")).unwrap();
    std::os::unix::fs::symlink("/dev/zero", link.join("host/main.mjs")).unwrap();
    let r = diagnose(&link).expect("a symlink where a file is listed");
    assert_eq!((r.check, r.file.as_deref()), (Some("symlink"), Some("host/main.mjs")));
    // A folder on the way to a listed file that is a symlink is not followed either: the same file elsewhere is not read
    let via = c.bundle("Via", "0.2.7");
    fs::rename(via.join("host"), c.t.join("elsewhere")).unwrap();
    std::os::unix::fs::symlink(c.t.join("elsewhere"), via.join("host")).unwrap();
    let r = diagnose(&via).expect("a folder on the way that is a symlink");
    // The first listed file under the linked folder
    assert_eq!(r.check, Some("symlink"));
    assert!(r.file.as_deref().is_some_and(|f| f.starts_with("host/")), "{:?}", r.file);
    assert!(r.message.contains("goes through a symlink at \"host\""), "{}", r.message);
    assert!(hash_listed(&via, "host/main.mjs", 10_000).is_err(), "the hash of a file reached through a symlinked folder is not taken");
    assert_eq!(through_symlink(&via, "host/main.mjs").as_deref(), Some("host"));
    assert_eq!(through_symlink(&good, "host/main.mjs"), None);
    let long = c.bundle("Long", "0.2.6");
    fs::write(long.join("host/main.mjs"), vec![b'x'; 5_000_000]).unwrap();
    let r = diagnose(&long).expect("a longer file");
    assert_eq!((r.check, r.file.as_deref()), (Some("size-mismatch"), Some("host/main.mjs")));

    // The signature, the platform and the floor are the shell's checks, answered first
    let unknown = c.t.join("U.app/Contents/Resources/content");
    write_content(&unknown, "0.2.4", &files("0.2.4"), &key());
    assert_eq!(diagnose(&unknown).map(|r| r.check), Some(Some("unknown-key")));
    let log = |_: &str| ();
    let other_platform = Verifier { keys: &c.keys, platform: "linux-x64".into(), log: &log };
    assert_eq!(diagnose_with(&other_platform, &c.data(), &good).map(|r| r.check), Some(Some("wrong-platform")));
    fs::create_dir_all(content_root(&c.data())).unwrap();
    fs::write(floor_path(&c.data()), "0.3.0\n").unwrap();
    assert_eq!(diagnose(&good).map(|r| r.check), Some(Some("downgrade")));

    // Nothing was copied or started by looking
    assert!(!version_dir(&c.data(), "0.2.0").exists() && !version_dir(&c.data(), "0.2.1").exists());
}

/// The ids are the window's vocabulary: one per refusal of the verifier, none twice, and a file named
/// for the ones that are about a file.
#[test]
fn every_refusal_of_the_verifier_has_its_own_id_and_the_ones_about_a_file_name_it() {
    let cases: Vec<(Error, &str, Option<&str>)> = vec![
        (Error::Missing("content-manifest.json"), "missing-file", Some("content-manifest.json")),
        (Error::BadFile { name: "content-manifest.json.sig", reason: "is a symlink" }, "bad-file", Some("content-manifest.json.sig")),
        (Error::ManifestMalformed("x".into()), "manifest-malformed", None),
        (Error::SignatureMalformed("x".into()), "signature-malformed", None),
        (Error::UnsupportedFormat(2), "unsupported-format", None),
        (Error::UnknownKey("0011223344556677".into()), "unknown-key", None),
        (Error::BadSignature, "bad-signature", None),
        (Error::WrongPlatform { expected: "darwin-arm64".into(), found: "linux-x64".into() }, "wrong-platform", None),
        (Error::ShellTooOld { needed: 2, have: 1 }, "shell-too-old", None),
        (Error::BadPath { path: "../x".into(), reason: "has a .. component" }, "bad-path", Some("../x")),
        (Error::DuplicatePath("a".into()), "duplicate-path", Some("a")),
        (Error::Symlink("a/b".into()), "symlink", Some("a/b")),
        (Error::NotRegularFile("a".into()), "not-regular-file", Some("a")),
        (Error::SizeMismatch { path: "a".into(), expected: 1, found: 2 }, "size-mismatch", Some("a")),
        (Error::HashMismatch("a".into()), "hash-mismatch", Some("a")),
        (Error::CopyMismatch("a".into()), "copy-mismatch", Some("a")),
        (Error::DestinationExists(PathBuf::from("/d")), "destination-exists", None),
        (Error::BadVersion("x".into()), "bad-version", None),
        (Error::Downgrade { candidate: "0.1.0".into(), highest: "0.2.0".into() }, "downgrade", None),
        (Error::Io { context: "read".into(), source: std::io::Error::other("x"), step: content_verify::IoStep::Read }, "io", None),
    ];
    let mut ids = std::collections::BTreeSet::new();
    for (e, id, file) in &cases {
        assert_eq!(check_id(e), *id, "{e}");
        assert_eq!(file_of(e), *file, "{e}");
        ids.insert(*id);
    }
    assert_eq!(ids.len(), cases.len(), "an id is used twice");
}
