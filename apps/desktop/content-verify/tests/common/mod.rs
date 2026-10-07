//! Test helpers: a signer that mirrors scripts/content-manifest.mts, and temporary folders.
//!
//! Signing keys here are made from fresh random bytes on every run and never leave memory.
#![allow(dead_code)]

use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use content_verify::{key_id, remove_content, Expect, TrustedKey, MANIFEST_NAME, SIGNATURE_NAME};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const PLATFORM: &str = "test-platform";

pub fn expect() -> Expect {
    Expect {
        platform: PLATFORM.into(),
        shell_version: Some(1),
    }
}

pub fn new_key() -> SigningKey {
    let mut seed = [0u8; 32];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut seed)
        .unwrap();
    SigningKey::from_bytes(&seed)
}

pub fn trusted(name: &str, key: &SigningKey) -> TrustedKey {
    TrustedKey::from_raw(name, key.verifying_key().as_bytes()).unwrap()
}

pub fn id_of(key: &SigningKey) -> String {
    key_id(key.verifying_key().as_bytes())
}

/// A folder removed (read-only parts included) when dropped.
pub struct Temp(pub PathBuf);

impl Temp {
    pub fn new(tag: &str) -> Temp {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "content-verify-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_content(&p);
        fs::create_dir_all(&p).unwrap();
        Temp(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = remove_content(&self.0);
    }
}

pub fn write_file(dir: &Path, rel: &str, bytes: &[u8], executable: bool) {
    let p = dir.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, bytes).unwrap();
    fs::set_permissions(
        &p,
        fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
    )
    .unwrap();
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One listed file, as the writer would describe it.
pub fn entry(path: &str, bytes: &[u8], executable: bool) -> serde_json::Value {
    json!({ "path": path, "size": bytes.len(), "sha256": sha256_hex(bytes), "executable": executable })
}

pub fn manifest_json(files: Vec<serde_json::Value>) -> serde_json::Value {
    json!({ "format": 1, "appVersion": "0.1.0-beta.12", "platform": PLATFORM, "minShellVersion": 1, "files": files })
}

pub fn to_bytes(v: &serde_json::Value) -> Vec<u8> {
    let mut s = serde_json::to_string_pretty(v).unwrap();
    s.push('\n');
    s.into_bytes()
}

pub fn signature_for(manifest: &[u8], key: &SigningKey) -> Vec<u8> {
    let sig = key.sign(manifest);
    to_bytes(&json!({
        "format": 1,
        "algorithm": "ed25519",
        "keyId": id_of(key),
        "signature": STANDARD.encode(sig.to_bytes()),
    }))
}

/// Write `manifest` and its signature by `key` into `dir`.
pub fn sign_into(dir: &Path, manifest: &[u8], key: &SigningKey) {
    fs::write(dir.join(MANIFEST_NAME), manifest).unwrap();
    fs::write(dir.join(SIGNATURE_NAME), signature_for(manifest, key)).unwrap();
}

/// A content folder with `files` (path, bytes, executable), signed by `key`.
pub fn content(tag: &str, files: &[(&str, Vec<u8>, bool)], key: &SigningKey) -> Temp {
    let t = Temp::new(tag);
    let src = t.join("src");
    fs::create_dir_all(&src).unwrap();
    let mut entries = Vec::new();
    for (path, bytes, exe) in files {
        write_file(&src, path, bytes, *exe);
        entries.push(entry(path, bytes, *exe));
    }
    sign_into(&src, &to_bytes(&manifest_json(entries)), key);
    t
}

/// Bytes that are not all the same, so a misplaced chunk changes the hash.
pub fn pattern(len: usize, salt: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u32).wrapping_mul(2_654_435_761).to_le_bytes()[1] ^ salt)
        .collect()
}

/// No partial folder left beside the destination, and no destination.
pub fn assert_nothing_left(t: &Temp) {
    let dest = t.join("dest");
    assert!(
        fs::symlink_metadata(&dest).is_err(),
        "the destination must not exist after a refusal"
    );
    let leftovers: Vec<_> = fs::read_dir(t.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".partial-"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "a partial copy was left behind: {leftovers:?}"
    );
}
