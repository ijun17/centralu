//! Verifying a copy where it is (`verify_in_place`) and reading a verified manifest on its own
//! (`read_verified_manifest`): what the shell does when the version's folder is already there.

mod common;

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

use common::*;
use content_verify::{read_verified_manifest, verify_and_copy, verify_in_place, Error, MANIFEST_NAME};

fn files() -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![
        ("centralu-keeper", pattern(3000, 1), true),
        ("host/main.mjs", pattern(700, 2), false),
        ("host/node_modules/a/b.node", pattern(300_000, 3), true),
        ("host/empty", Vec::new(), false),
    ]
}

/// A source signed by `key` and its verified copy at `dest`.
fn copied(tag: &str, key: &ed25519_dalek::SigningKey) -> Temp {
    let t = content(tag, &files(), key);
    verify_and_copy(&t.join("src"), &t.join("dest"), &[trusted("current", key)], &expect()).unwrap();
    t
}

/// Make a read-only copy writable at `rel` (and its folder) so a test can change it, as another
/// process of the same user could.
fn unlock(dest: &Path, rel: &str) {
    let p = dest.join(rel);
    let mut dir = p.parent().unwrap().to_path_buf();
    loop {
        if dir.exists() {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        }
        if dir == dest {
            break;
        }
        dir = dir.parent().unwrap().to_path_buf();
    }
    if p.exists() {
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    }
}

#[test]
fn a_copy_verifies_in_place_with_the_same_manifest_bytes_as_its_source() {
    let key = new_key();
    let t = copied("ok", &key);
    let keys = [trusted("current", &key)];
    let (m, bytes) = verify_in_place(&t.join("dest"), &keys, &expect()).unwrap();
    assert_eq!(m.app_version, "0.1.0-beta.12");
    assert_eq!(m.files.len(), 4);
    let (src, src_bytes) = read_verified_manifest(&t.join("src"), &keys, &expect()).unwrap();
    assert_eq!(src, m);
    assert_eq!(src_bytes, bytes);
    assert_eq!(bytes, fs::read(t.join("dest").join(MANIFEST_NAME)).unwrap());
}

#[test]
fn reading_a_manifest_checks_its_signature_and_nothing_else() {
    let key = new_key();
    let t = content("read", &files(), &key);
    // The files themselves are not looked at.
    fs::write(t.join("src/host/main.mjs"), b"changed").unwrap();
    assert!(read_verified_manifest(&t.join("src"), &[trusted("current", &key)], &expect()).is_ok());
    let other = new_key();
    assert!(matches!(
        read_verified_manifest(&t.join("src"), &[trusted("current", &other)], &expect()),
        Err(Error::UnknownKey(_))
    ));
    let mut old_shell = expect();
    old_shell.shell_version = Some(0);
    assert!(matches!(
        read_verified_manifest(&t.join("src"), &[trusted("current", &key)], &old_shell),
        Err(Error::ShellTooOld { needed: 1, have: 0 })
    ));
}

#[test]
fn every_change_to_a_copy_is_refused() {
    type Change = fn(&Path);
    let changes: Vec<(&str, Change)> = vec![
        ("a listed file's bytes", |d| {
            unlock(d, "host/main.mjs");
            let mut b = fs::read(d.join("host/main.mjs")).unwrap();
            b[10] ^= 1;
            fs::write(d.join("host/main.mjs"), b).unwrap();
            fs::set_permissions(d.join("host/main.mjs"), fs::Permissions::from_mode(0o444)).unwrap();
        }),
        ("a listed file cut short", |d| {
            unlock(d, "host/node_modules/a/b.node");
            let b = fs::read(d.join("host/node_modules/a/b.node")).unwrap();
            fs::write(d.join("host/node_modules/a/b.node"), &b[..b.len() - 1]).unwrap();
            fs::set_permissions(d.join("host/node_modules/a/b.node"), fs::Permissions::from_mode(0o555)).unwrap();
        }),
        ("a listed file grown", |d| {
            unlock(d, "host/empty");
            fs::write(d.join("host/empty"), b"x").unwrap();
            fs::set_permissions(d.join("host/empty"), fs::Permissions::from_mode(0o444)).unwrap();
        }),
        ("a listed file removed", |d| {
            unlock(d, "host/main.mjs");
            fs::remove_file(d.join("host/main.mjs")).unwrap();
        }),
        ("a listed file made writable", |d| {
            fs::set_permissions(d.join("host/main.mjs"), fs::Permissions::from_mode(0o644)).unwrap();
        }),
        ("the keeper's exec bit removed", |d| {
            fs::set_permissions(d.join("centralu-keeper"), fs::Permissions::from_mode(0o444)).unwrap();
        }),
        ("a data file made executable", |d| {
            fs::set_permissions(d.join("host/main.mjs"), fs::Permissions::from_mode(0o555)).unwrap();
        }),
        ("an unlisted file at the top", |d| {
            unlock(d, "dropped.mjs");
            fs::write(d.join("dropped.mjs"), b"x").unwrap();
        }),
        ("an unlisted file deep down", |d| {
            unlock(d, "host/node_modules/a/extra.node");
            fs::write(d.join("host/node_modules/a/extra.node"), b"x").unwrap();
        }),
        ("an unlisted folder", |d| {
            unlock(d, "host/new/x");
            fs::create_dir(d.join("host/new")).unwrap();
        }),
        ("a listed file swapped for a symlink to an identical one", |d| {
            unlock(d, "host/main.mjs");
            let b = fs::read(d.join("host/main.mjs")).unwrap();
            fs::write(d.join("../same.mjs"), b).unwrap();
            fs::remove_file(d.join("host/main.mjs")).unwrap();
            symlink(d.join("../same.mjs"), d.join("host/main.mjs")).unwrap();
        }),
        ("a symlink beside the listed files", |d| {
            unlock(d, "link");
            symlink("/etc/hosts", d.join("link")).unwrap();
        }),
        ("the manifest changed", |d| {
            unlock(d, MANIFEST_NAME);
            let mut b = fs::read(d.join(MANIFEST_NAME)).unwrap();
            let at = b.len() - 3;
            b[at] ^= 1;
            fs::write(d.join(MANIFEST_NAME), b).unwrap();
        }),
    ];
    let key = new_key();
    for (what, change) in changes {
        let t = copied("change", &key);
        let dest = t.join("dest");
        assert!(verify_in_place(&dest, &[trusted("current", &key)], &expect()).is_ok(), "{what}: before");
        change(&dest);
        let result = verify_in_place(&dest, &[trusted("current", &key)], &expect());
        assert!(result.is_err(), "{what}: a changed copy verified");
    }
}

#[test]
fn a_copy_signed_by_a_key_not_trusted_is_refused_in_place() {
    let key = new_key();
    let t = copied("key", &key);
    assert!(matches!(
        verify_in_place(&t.join("dest"), &[trusted("current", &new_key())], &expect()),
        Err(Error::UnknownKey(_))
    ));
}
