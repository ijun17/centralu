//! The Node writer and this verifier, checked against each other.
//!
//! `tests/fixtures/writer/content` was signed by `scripts/content-manifest.mts` with a throwaway key
//! whose public half is `key.pub` (the private half was never written anywhere). This test verifies
//! the writer's bytes as they are; `tooling/content-manifest.test.ts` checks that the writer still
//! produces exactly those manifest bytes from the same folder. Together: what the writer signs, this
//! crate accepts. To regenerate after a deliberate format change:
//!
//!   pnpm exec tsx scripts/content-manifest.mts sign apps/desktop/content-verify/tests/fixtures/writer/content \
//!     --app-version 0.0.0-fixture.1 --platform darwin-arm64
//!
//! and put the printed public key in `key.pub`.

mod common;

use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::*;
use content_verify::{
    embedded_keys, verify_and_copy, verify_manifest, Error, Expect, TrustedKey, MANIFEST_NAME,
    SIGNATURE_NAME,
};

fn fixture() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/writer"
    ))
}

fn writer_key() -> TrustedKey {
    let b64 = fs::read_to_string(fixture().join("key.pub")).unwrap();
    TrustedKey::from_raw("writer fixture", &STANDARD.decode(b64.trim()).unwrap()).unwrap()
}

fn darwin() -> Expect {
    Expect {
        platform: "darwin-arm64".into(),
        shell_version: Some(1),
    }
}

#[test]
fn what_the_node_writer_signed_verifies_and_copies_byte_for_byte() {
    let src = fixture().join("content");
    let t = Temp::new("writer");
    let m = verify_and_copy(&src, &t.join("dest"), &[writer_key()], &darwin()).unwrap();
    assert_eq!(m.app_version, "0.0.0-fixture.1");
    let paths: Vec<&str> = m.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "centralu-keeper",
            "host/.hidden",
            "host/bytes.bin",
            "host/empty",
            "host/main.mjs",
            "host/modules/x/\u{fc}n\u{ef}.txt"
        ]
    );
    for f in &m.files {
        assert_eq!(
            fs::read(t.join("dest").join(&f.path)).unwrap(),
            fs::read(src.join(&f.path)).unwrap(),
            "{}",
            f.path
        );
    }
    assert!(m.files[0].executable && !m.files[1].executable);
    for name in [MANIFEST_NAME, SIGNATURE_NAME] {
        assert_eq!(
            fs::read(t.join("dest").join(name)).unwrap(),
            fs::read(src.join(name)).unwrap()
        );
    }
}

#[test]
fn the_writers_throwaway_key_is_refused_by_the_built_in_keys() {
    let src = fixture().join("content");
    let m = fs::read(src.join(MANIFEST_NAME)).unwrap();
    let s = fs::read(src.join(SIGNATURE_NAME)).unwrap();
    assert!(matches!(
        verify_manifest(&m, &s, &embedded_keys().unwrap(), &darwin()),
        Err(Error::UnknownKey(_))
    ));
}

#[test]
fn the_writers_key_id_is_the_one_this_crate_computes() {
    let s: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture().join("content").join(SIGNATURE_NAME)).unwrap())
            .unwrap();
    assert_eq!(s["keyId"].as_str().unwrap(), writer_key().id);
}
