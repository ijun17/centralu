//! Putting verified content into `<data>/content/<version>/` (`place`), removing a copy (`discard`), and
//! whose fault a refusal is (`Error::fault`): the one implementation the shell and the keeper share.

mod common;

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};

use common::*;
use content_verify::{discard, place, read_verified_manifest, Error, Fault, Manifest, PlaceError, Placement, Placing, TrustedKey};

fn files() -> Vec<(&'static str, Vec<u8>, bool)> {
    vec![("centralu-keeper", pattern(3000, 1), true), ("host/main.mjs", pattern(700, 2), false)]
}

/// What a placement logged, in words a test can compare.
fn run(t: &Temp, keys: &[TrustedKey], in_use: bool) -> (Result<PathBuf, PlaceError>, Vec<String>) {
    let (manifest, bytes): (Manifest, Vec<u8>) = read_verified_manifest(&t.join("src"), keys, &expect()).unwrap();
    let root = t.join("data/content");
    let expect = expect();
    let p = Placement { root: &root, src: &t.join("src"), manifest: &manifest, manifest_bytes: &bytes, keys, expect: &expect, in_use };
    let mut said = Vec::new();
    let placed = place(&p, &mut |step| {
        said.push(match step {
            Placing::Reused(_) => "reused".to_string(),
            Placing::Replacing(_, why) => format!("replacing: {why}"),
            Placing::Copied(_, n) => format!("copied {n}"),
        })
    });
    (placed, said)
}

fn dest(t: &Temp) -> PathBuf {
    t.join("data/content/0.1.0-beta.12")
}

#[test]
fn copies_once_then_uses_the_copy_that_verifies() {
    let key = new_key();
    let t = content("place-twice", &files(), &key);
    let keys = [trusted("current", &key)];
    let (first, said) = run(&t, &keys, false);
    assert_eq!(first.unwrap(), dest(&t));
    assert_eq!(said, ["copied 2"]);
    assert_eq!(fs::metadata(t.join("data/content")).unwrap().permissions().mode() & 0o777, 0o700);
    let (second, said) = run(&t, &keys, false);
    assert_eq!(second.unwrap(), dest(&t));
    assert_eq!(said, ["reused"]);
}

#[test]
fn a_copy_that_no_longer_verifies_is_copied_again_unless_something_runs_from_it() {
    let key = new_key();
    let t = content("place-damaged", &files(), &key);
    let keys = [trusted("current", &key)];
    run(&t, &keys, false).0.unwrap();
    let main = dest(&t).join("host/main.mjs");
    fs::set_permissions(dest(&t).join("host"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&main, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&main, b"changed").unwrap();

    match run(&t, &keys, true).0 {
        Err(PlaceError::InUse(at, why)) => {
            assert_eq!(at, dest(&t));
            assert!(why.starts_with("does not verify"), "{why}");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fs::read(&main).unwrap(), b"changed", "what something runs from is left alone");

    let (again, said) = run(&t, &keys, false);
    assert_eq!(again.unwrap(), dest(&t));
    assert_eq!(said.len(), 2, "{said:?}");
    assert!(said[0].starts_with("replacing: does not verify"), "{said:?}");
    assert_eq!(said[1], "copied 2");
    assert_eq!(fs::read(&main).unwrap(), pattern(700, 2));
}

#[test]
fn a_file_or_a_symlink_at_the_versions_name_is_replaced_by_the_copy() {
    let key = new_key();
    let keys = [trusted("current", &key)];
    for (tag, make) in [
        ("place-file", (|d: &Path| fs::write(d, b"not a folder").unwrap()) as fn(&Path)),
        ("place-link", |d: &Path| symlink("/", d).unwrap()),
    ] {
        let t = content(tag, &files(), &key);
        fs::create_dir_all(t.join("data/content")).unwrap();
        make(&dest(&t));
        let (placed, said) = run(&t, &keys, false);
        assert_eq!(placed.unwrap(), dest(&t), "{tag}");
        assert!(said[0].starts_with("replacing: "), "{tag}: {said:?}");
        assert!(fs::symlink_metadata(dest(&t)).unwrap().is_dir(), "{tag}");
    }
}

#[test]
fn discard_removes_a_read_only_copy_a_file_or_a_symlink_and_nothing_is_no_error() {
    let key = new_key();
    let t = content("discard", &files(), &key);
    run(&t, &[trusted("current", &key)], false).0.unwrap();
    discard(&dest(&t)).unwrap();
    assert!(fs::symlink_metadata(dest(&t)).is_err());
    discard(&dest(&t)).unwrap();

    let file = t.join("a-file");
    fs::write(&file, b"x").unwrap();
    discard(&file).unwrap();
    assert!(!file.exists());

    // A symlink goes, what it points at stays
    let link = t.join("a-link");
    symlink(t.join("src"), &link).unwrap();
    discard(&link).unwrap();
    assert!(fs::symlink_metadata(&link).is_err());
    assert!(t.join("src/host/main.mjs").exists());
}

/// The shell and the keeper word a refusal from its fault. They used to tell a read of the content
/// from a write of the copy by the words of the error's context, which a rewording here would have
/// silently turned into the other refusal.
#[test]
fn a_file_missing_from_the_content_is_its_fault_and_a_folder_that_cannot_be_written_is_the_copys() {
    let key = new_key();
    let keys = [trusted("current", &key)];

    let t = content("fault-source", &files(), &key);
    fs::remove_file(t.join("src/host/main.mjs")).unwrap();
    match run(&t, &keys, false).0 {
        Err(PlaceError::Copy(e)) => {
            assert!(e.reads_the_source(), "{e}");
            assert_eq!(e.fault(true), Fault::Unreadable, "{e}");
        }
        other => panic!("{other:?}"),
    }

    let t = content("fault-copy", &files(), &key);
    let root = t.join("data/content");
    fs::create_dir_all(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();
    let placed = run(&t, &keys, false).0;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    match placed {
        Err(PlaceError::Copy(e)) => {
            assert!(matches!(e, Error::Io { .. }) && !e.reads_the_source(), "{e}");
            assert_eq!(e.fault(true), Fault::Copy, "{e}");
            // Read from the content alone (not copying), an I/O failure is the content's
            assert_eq!(e.fault(false), Fault::Unreadable);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(Error::BadSignature.fault(true), Fault::Unsigned);
    assert_eq!(Error::Missing("content-manifest.json").fault(false), Fault::Unreadable);
}
