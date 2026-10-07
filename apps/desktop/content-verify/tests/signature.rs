//! The signature and the manifest, before any file is touched.

mod common;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use content_verify::{embedded_keys, verify_manifest, Error, Expect, TrustedKey};
use serde_json::json;

fn signed(key: &ed25519_dalek::SigningKey) -> (Vec<u8>, Vec<u8>) {
    let m = to_bytes(&manifest_json(vec![
        entry("centralu-keeper", b"keeper", true),
        entry("host/main.mjs", b"main", false),
        entry("host/empty", b"", false),
    ]));
    let s = signature_for(&m, key);
    (m, s)
}

#[test]
fn content_signed_with_the_current_key_verifies() {
    let (current, next) = (new_key(), new_key());
    let keys = [trusted("current", &current), trusted("next", &next)];
    let (m, s) = signed(&current);
    let got = verify_manifest(&m, &s, &keys, &expect()).unwrap();
    assert_eq!(got.key_id, keys[0].id);
    assert_eq!(got.files.len(), 3);
    assert_eq!(got.app_version, "0.1.0-beta.12");
}

#[test]
fn content_signed_with_the_next_key_verifies() {
    let (current, next) = (new_key(), new_key());
    let keys = [trusted("current", &current), trusted("next", &next)];
    let (m, s) = signed(&next);
    assert_eq!(
        verify_manifest(&m, &s, &keys, &expect()).unwrap().key_id,
        keys[1].id
    );
}

#[test]
fn a_key_that_is_not_trusted_is_refused_as_unknown() {
    let keys = [trusted("current", &new_key()), trusted("next", &new_key())];
    let (m, s) = signed(&new_key());
    assert!(matches!(
        verify_manifest(&m, &s, &keys, &expect()),
        Err(Error::UnknownKey(_))
    ));
}

#[test]
fn a_signature_claiming_a_trusted_key_id_but_made_by_another_key_is_refused() {
    let current = new_key();
    let keys = [trusted("current", &current)];
    let other = new_key();
    let (m, _) = signed(&other);
    let forged = to_bytes(&json!({
        "format": 1, "algorithm": "ed25519", "keyId": id_of(&current),
        "signature": STANDARD.encode(ed25519_dalek::Signer::sign(&other, &m).to_bytes()),
    }));
    assert!(matches!(
        verify_manifest(&m, &forged, &keys, &expect()),
        Err(Error::BadSignature)
    ));
}

#[test]
fn the_built_in_keys_are_current_and_next_from_keys_json() {
    let json: serde_json::Value =
        serde_json::from_str(include_str!("../../../../packaging/shell/keys.json")).unwrap();
    let keys = embedded_keys().unwrap();
    let names: Vec<&str> = keys.iter().map(|k| k.name.as_str()).collect();
    assert_eq!(names, ["current", "next"]);
    for k in &keys {
        let raw = STANDARD.decode(json[&k.name].as_str().unwrap()).unwrap();
        assert_eq!(k.raw().as_slice(), raw.as_slice());
        assert_eq!(k.id.len(), 16);
    }
    assert_ne!(keys[0].id, keys[1].id);
}

#[test]
fn a_throwaway_key_never_verifies_against_the_built_in_keys() {
    let keys = embedded_keys().unwrap();
    for _ in 0..32 {
        let (m, s) = signed(&new_key());
        assert!(matches!(
            verify_manifest(&m, &s, &keys, &expect()),
            Err(Error::UnknownKey(_))
        ));
    }
}

/// Every byte of the manifest matters: flipping any one bit of any byte is refused, at every
/// position, before the manifest is parsed.
#[test]
fn flipping_any_bit_of_any_manifest_byte_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, s) = signed(&key);
    for i in 0..m.len() {
        for bit in 0..8 {
            let mut t = m.clone();
            t[i] ^= 1 << bit;
            match verify_manifest(&t, &s, &keys, &expect()) {
                Err(Error::BadSignature) => {}
                other => panic!("byte {i} bit {bit}: expected BadSignature, got {other:?}"),
            }
        }
    }
}

#[test]
fn a_truncated_or_extended_manifest_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, s) = signed(&key);
    for len in 0..m.len() {
        assert!(
            matches!(
                verify_manifest(&m[..len], &s, &keys, &expect()),
                Err(Error::BadSignature)
            ),
            "len {len}"
        );
    }
    for extra in [&b"\n"[..], b" ", b"\0", b"{}"] {
        let mut t = m.clone();
        t.extend_from_slice(extra);
        assert!(matches!(
            verify_manifest(&t, &s, &keys, &expect()),
            Err(Error::BadSignature)
        ));
    }
}

/// Every bit of the 64 signature bytes.
#[test]
fn flipping_any_bit_of_the_signature_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, _) = signed(&key);
    let sig = ed25519_dalek::Signer::sign(&key, &m).to_bytes();
    for i in 0..64 {
        for bit in 0..8 {
            let mut t = sig;
            t[i] ^= 1 << bit;
            let file = to_bytes(&json!({
                "format": 1, "algorithm": "ed25519", "keyId": id_of(&key), "signature": STANDARD.encode(t),
            }));
            match verify_manifest(&m, &file, &keys, &expect()) {
                Err(Error::BadSignature) => {}
                other => panic!("byte {i} bit {bit}: got {other:?}"),
            }
        }
    }
}

/// And every byte of the signature file around them: the key id, the format, the algorithm,
/// the JSON itself. (A signature file carries no comment here; a comment is not trusted, below.)
#[test]
fn flipping_any_byte_of_the_signature_file_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, s) = signed(&key);
    for i in 0..s.len() {
        for bit in 0..8 {
            let mut t = s.clone();
            t[i] ^= 1 << bit;
            if let Ok(got) = verify_manifest(&m, &t, &keys, &expect()) {
                panic!(
                    "byte {i} ({:?}) bit {bit} still verified: {got:?}",
                    s[i] as char
                );
            }
        }
    }
}

#[test]
fn the_comment_in_a_signature_file_is_not_trusted_and_changes_nothing() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, _) = signed(&key);
    let sig = STANDARD.encode(ed25519_dalek::Signer::sign(&key, &m).to_bytes());
    for comment in ["release key current", "anything at all"] {
        let file = to_bytes(&json!({
            "format": 1, "algorithm": "ed25519", "keyId": id_of(&key), "signature": sig, "comment": comment,
        }));
        assert!(verify_manifest(&m, &file, &keys, &expect()).is_ok());
    }
}

#[test]
fn a_missing_empty_or_malformed_signature_file_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, s) = signed(&key);
    let good: serde_json::Value = serde_json::from_slice(&s).unwrap();
    let mut cases: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"null".to_vec(),
        b"{}".to_vec(),
        b"[]".to_vec(),
    ];
    for (field, value) in [
        ("signature", json!("")),
        ("signature", json!("not base64!")),
        ("signature", json!(STANDARD.encode([0u8; 63]))),
        ("signature", json!(STANDARD.encode([0u8; 65]))),
        ("algorithm", json!("rsa")),
        ("format", json!(2)),
        ("format", json!(0)),
        ("keyId", json!("")),
        ("keyId", json!(null)),
    ] {
        let mut v = good.clone();
        v[field] = value;
        cases.push(to_bytes(&v));
    }
    for field in ["format", "algorithm", "keyId", "signature"] {
        let mut v = good.clone();
        v.as_object_mut().unwrap().remove(field);
        cases.push(to_bytes(&v));
    }
    // A duplicated field: JSON readers disagree on which one wins, so neither does.
    let text = String::from_utf8(s.clone()).unwrap();
    cases.push(
        text.replacen("\"format\": 1,", "\"format\": 1, \"format\": 1,", 1)
            .into_bytes(),
    );
    for (i, c) in cases.iter().enumerate() {
        assert!(
            verify_manifest(&m, c, &keys, &expect()).is_err(),
            "case {i}: {}",
            String::from_utf8_lossy(c)
        );
    }
}

/// A signature over a different (or no) manifest must not be accepted with this one.
#[test]
fn a_valid_signature_for_another_manifest_is_refused() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    let (m, _) = signed(&key);
    let other = to_bytes(&manifest_json(vec![entry("host/main.mjs", b"evil", false)]));
    let s = signature_for(&other, &key);
    assert!(matches!(
        verify_manifest(&m, &s, &keys, &expect()),
        Err(Error::BadSignature)
    ));
}

fn verify_json(
    v: serde_json::Value,
    expect: &Expect,
) -> content_verify::Result<content_verify::Manifest> {
    let key = new_key();
    let m = to_bytes(&v);
    verify_manifest(
        &m,
        &signature_for(&m, &key),
        &[trusted("current", &key)],
        expect,
    )
}

#[test]
fn a_manifest_for_another_platform_is_refused() {
    let mut v = manifest_json(vec![]);
    v["platform"] = json!("linux-x64");
    assert!(matches!(
        verify_json(v.clone(), &expect()),
        Err(Error::WrongPlatform { .. })
    ));
    // Exact match, not a prefix or a case-insensitive one.
    for p in ["test-platform ", "Test-platform", "test", ""] {
        v["platform"] = json!(p);
        assert!(
            matches!(
                verify_json(v.clone(), &expect()),
                Err(Error::WrongPlatform { .. })
            ),
            "{p:?}"
        );
    }
}

#[test]
fn a_manifest_needing_a_newer_shell_is_refused_and_says_which() {
    for (min, have, ok) in [
        (0, 1, true),
        (1, 1, true),
        (2, 1, false),
        (1, 0, false),
        (7, 6, false),
        (7, 8, true),
    ] {
        let mut v = manifest_json(vec![]);
        v["minShellVersion"] = json!(min);
        let e = Expect {
            platform: PLATFORM.into(),
            shell_version: Some(have),
        };
        match verify_json(v, &e) {
            Ok(_) => assert!(ok, "min {min} have {have}"),
            Err(Error::ShellTooOld { needed, have: h }) => {
                assert!(!ok && needed == min && h == have)
            }
            Err(other) => panic!("{other:?}"),
        }
    }
    // The keeper does not know the shell's version and does not judge it.
    let mut v = manifest_json(vec![]);
    v["minShellVersion"] = json!(99);
    assert!(verify_json(
        v,
        &Expect {
            platform: PLATFORM.into(),
            shell_version: None
        }
    )
    .is_ok());
}

#[test]
fn a_manifest_of_another_format_is_refused() {
    for f in [0, 2, 100] {
        let mut v = manifest_json(vec![]);
        v["format"] = json!(f);
        assert!(matches!(verify_json(v, &expect()), Err(Error::UnsupportedFormat(n)) if n == f));
    }
}

#[test]
fn unknown_manifest_fields_are_ignored_so_a_compatible_addition_needs_no_new_shell() {
    let mut v = manifest_json(vec![entry("a", b"a", false)]);
    v["somethingNew"] = json!({ "x": 1 });
    v["files"][0]["alsoNew"] = json!(true);
    assert!(verify_json(v, &expect()).is_ok());
}

#[test]
fn malformed_manifest_fields_are_refused() {
    let base = manifest_json(vec![entry("a", b"a", false)]);
    let mut cases = Vec::new();
    for (ptr, value) in [
        ("/appVersion", json!("not a version")),
        ("/appVersion", json!("1.2")),
        ("/appVersion", json!("1.2.3+build")),
        ("/minShellVersion", json!(-1)),
        ("/minShellVersion", json!("1")),
        ("/files/0/size", json!(-1)),
        ("/files/0/size", json!(1.5)),
        ("/files/0/sha256", json!("AB".repeat(32))),
        ("/files/0/sha256", json!("ab".repeat(31))),
        ("/files/0/sha256", json!("ab".repeat(33))),
        ("/files/0/sha256", json!("zz".repeat(32))),
        ("/files/0/executable", json!("yes")),
        ("/files", json!({})),
    ] {
        let mut v = base.clone();
        *v.pointer_mut(ptr).unwrap() = value;
        cases.push(v);
    }
    for field in [
        "appVersion",
        "platform",
        "minShellVersion",
        "files",
        "format",
    ] {
        let mut v = base.clone();
        v.as_object_mut().unwrap().remove(field);
        cases.push(v);
    }
    for field in ["path", "size", "sha256", "executable"] {
        let mut v = base.clone();
        v["files"][0].as_object_mut().unwrap().remove(field);
        cases.push(v);
    }
    for (i, v) in cases.into_iter().enumerate() {
        assert!(verify_json(v.clone(), &expect()).is_err(), "case {i}: {v}");
    }
}

#[test]
fn duplicate_paths_are_refused_also_when_they_differ_only_in_case() {
    for pair in [
        ["a", "a"],
        ["host/main.mjs", "host/main.mjs"],
        ["host/Main.mjs", "host/main.mjs"],
        ["HOST/x", "host/x"],
    ] {
        let v = manifest_json(vec![
            entry(pair[0], b"1", false),
            entry(pair[1], b"2", false),
        ]);
        assert!(
            matches!(verify_json(v, &expect()), Err(Error::DuplicatePath(_))),
            "{pair:?}"
        );
    }
    // Different files in folders that differ only in case are still different files.
    let v = manifest_json(vec![entry("a/x", b"1", false), entry("b/x", b"2", false)]);
    assert!(verify_json(v, &expect()).is_ok());
}

#[test]
fn a_path_that_is_also_the_folder_of_another_is_refused() {
    for pair in [["a", "a/b"], ["a/b", "a/b/c/d"], ["A", "a/b"]] {
        let v = manifest_json(vec![
            entry(pair[0], b"1", false),
            entry(pair[1], b"2", false),
        ]);
        assert!(
            matches!(verify_json(v, &expect()), Err(Error::BadPath { .. })),
            "{pair:?}"
        );
    }
}

/// The same table the Node writer is tested with (tests/fixtures/paths.json), so the two cannot
/// disagree about what a path may be.
#[test]
fn listed_paths_follow_the_shared_rules() {
    let table: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/paths.json")).unwrap();
    assert!(table.len() > 20);
    for row in table {
        let path = row["path"].as_str().unwrap();
        let ok = row["ok"].as_bool().unwrap();
        let got = verify_json(manifest_json(vec![entry(path, b"x", false)]), &expect());
        match (ok, &got) {
            (true, Ok(_)) | (false, Err(Error::BadPath { .. })) => {}
            _ => panic!("{path:?}: expected ok={ok}, got {got:?}"),
        }
    }
}

#[test]
fn a_weak_or_malformed_trusted_key_is_refused_when_built() {
    // The identity point, a small-order key under which signatures are not binding.
    let mut identity = [0u8; 32];
    identity[0] = 1;
    assert!(TrustedKey::from_raw("weak", &identity).is_err());
    assert!(TrustedKey::from_raw("short", &[1u8; 31]).is_err());
}
