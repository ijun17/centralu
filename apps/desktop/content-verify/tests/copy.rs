//! Copying: what reaches the destination, and everything that must keep it from existing.

mod common;

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

use common::*;
use content_verify::{remove_content, verify_and_copy, Error, MANIFEST_NAME, SIGNATURE_NAME};

/// The crate copies in chunks of this size (copy.rs `CHUNK`); the sweeps straddle it.
const CHUNK: usize = 256 * 1024;

fn run(
    t: &Temp,
    key: &ed25519_dalek::SigningKey,
) -> content_verify::Result<content_verify::Manifest> {
    verify_and_copy(
        &t.join("src"),
        &t.join("dest"),
        &[trusted("current", key)],
        &expect(),
    )
}

fn mode(p: &Path) -> u32 {
    fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn listed_files_arrive_byte_for_byte_read_only_with_their_exec_bit() {
    let key = new_key();
    let files = vec![
        ("centralu-keeper", pattern(5000, 1), true),
        ("host/main.mjs", pattern(1234, 2), false),
        ("host/empty", Vec::new(), false),
        (
            "host/node_modules/pkg/build/Release/addon.node",
            pattern(70_000, 3),
            true,
        ),
    ];
    let t = content("arrive", &files, &key);
    // Not listed, so not copied.
    write_file(&t.join("src"), "host/stray.mjs", b"not listed", false);

    let m = run(&t, &key).unwrap();
    assert_eq!(m.files.len(), 4);
    let dest = t.join("dest");
    for (path, bytes, exe) in &files {
        let p = dest.join(path);
        assert_eq!(&fs::read(&p).unwrap(), bytes, "{path}");
        assert_eq!(mode(&p), if *exe { 0o555 } else { 0o444 }, "{path}");
    }
    assert!(
        !dest.join("host/stray.mjs").exists(),
        "an unlisted file was copied"
    );
    for d in [
        "",
        "host",
        "host/node_modules",
        "host/node_modules/pkg/build/Release",
    ] {
        assert_eq!(mode(&dest.join(d)), 0o555, "folder {d:?}");
    }
    // The manifest and signature come along, unchanged, so the copy can be verified again.
    for name in [MANIFEST_NAME, SIGNATURE_NAME] {
        assert_eq!(
            fs::read(dest.join(name)).unwrap(),
            fs::read(t.join("src").join(name)).unwrap()
        );
        assert_eq!(mode(&dest.join(name)), 0o444);
    }
    let again = Temp::new("again");
    let m2 = verify_and_copy(
        &dest,
        &again.join("dest"),
        &[trusted("current", &key)],
        &expect(),
    )
    .unwrap();
    assert_eq!(m, m2);
    let partials = fs::read_dir(t.path()).unwrap().filter(|e| {
        e.as_ref()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".partial-")
    });
    assert_eq!(
        partials.count(),
        0,
        "a partial folder was left beside the copy"
    );
}

#[test]
fn sizes_around_the_copy_chunk_copy_intact() {
    let key = new_key();
    let sizes = [
        0,
        1,
        2,
        63,
        64,
        65,
        CHUNK - 1,
        CHUNK,
        CHUNK + 1,
        2 * CHUNK - 1,
        2 * CHUNK,
        2 * CHUNK + 1,
        3 * CHUNK + 7,
    ];
    let files: Vec<(String, Vec<u8>, bool)> = sizes
        .iter()
        .enumerate()
        .map(|(i, &n)| (format!("f/{n}"), pattern(n, i as u8), false))
        .collect();
    let refs: Vec<(&str, Vec<u8>, bool)> = files
        .iter()
        .map(|(p, b, e)| (p.as_str(), b.clone(), *e))
        .collect();
    let t = content("sizes", &refs, &key);
    run(&t, &key).unwrap();
    for (p, b, _) in &files {
        assert_eq!(&fs::read(t.join("dest").join(p)).unwrap(), b, "{p}");
    }
}

#[test]
fn a_large_file_of_several_megabytes_copies_intact() {
    let key = new_key();
    let big = pattern(9 * 1024 * 1024 + 13, 9);
    let t = content("large", &[("host/big.node", big.clone(), true)], &key);
    run(&t, &key).unwrap();
    assert_eq!(fs::read(t.join("dest/host/big.node")).unwrap(), big);
}

#[test]
fn many_files_in_many_folders_copy_intact() {
    let key = new_key();
    let files: Vec<(String, Vec<u8>, bool)> = (0..3000)
        .map(|i| {
            (
                format!("d{}/e{}/f{i}", i % 37, i % 5),
                pattern(i % 300, i as u8),
                i % 7 == 0,
            )
        })
        .collect();
    let refs: Vec<(&str, Vec<u8>, bool)> = files
        .iter()
        .map(|(p, b, e)| (p.as_str(), b.clone(), *e))
        .collect();
    let t = content("many", &refs, &key);
    assert_eq!(run(&t, &key).unwrap().files.len(), 3000);
    for (p, b, e) in files.iter().step_by(97) {
        let d = t.join("dest").join(p);
        assert_eq!(&fs::read(&d).unwrap(), b);
        assert_eq!(mode(&d), if *e { 0o555 } else { 0o444 });
    }
}

#[test]
fn an_empty_file_list_copies_only_the_manifest() {
    let key = new_key();
    let t = content("none", &[], &key);
    run(&t, &key).unwrap();
    let mut names: Vec<_> = fs::read_dir(t.join("dest"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, [MANIFEST_NAME, SIGNATURE_NAME]);
}

/// Every byte position of a file, changed after signing: refused, and nothing is left behind.
#[test]
fn changing_any_byte_of_a_file_is_refused() {
    let key = new_key();
    let original = pattern(300, 4);
    for i in 0..original.len() {
        let t = content("byte", &[("host/main.mjs", original.clone(), false)], &key);
        let mut b = original.clone();
        b[i] ^= 0x01;
        fs::write(t.join("src/host/main.mjs"), &b).unwrap();
        match run(&t, &key) {
            Err(Error::HashMismatch(p)) => assert_eq!(p, "host/main.mjs"),
            other => panic!("byte {i}: {other:?}"),
        }
        assert_nothing_left(&t);
    }
}

#[test]
fn changing_a_byte_at_a_chunk_edge_of_a_large_file_is_refused() {
    let key = new_key();
    let n = 3 * CHUNK + 5;
    let original = pattern(n, 5);
    for i in [0, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, n - 1] {
        let t = content("edge", &[("big", original.clone(), false)], &key);
        let mut b = original.clone();
        b[i] = b[i].wrapping_add(1);
        fs::write(t.join("src/big"), &b).unwrap();
        assert!(
            matches!(run(&t, &key), Err(Error::HashMismatch(_))),
            "byte {i}"
        );
        assert_nothing_left(&t);
    }
}

#[test]
fn a_truncated_file_is_refused_at_every_length() {
    let key = new_key();
    let original = pattern(40, 6);
    for len in 0..original.len() {
        let t = content("trunc", &[("a", original.clone(), false)], &key);
        fs::write(t.join("src/a"), &original[..len]).unwrap();
        match run(&t, &key) {
            Err(Error::SizeMismatch {
                expected: 40,
                found,
                ..
            }) => assert_eq!(found, len as u64),
            other => panic!("len {len}: {other:?}"),
        }
        assert_nothing_left(&t);
    }
}

#[test]
fn an_extended_file_is_refused_and_not_read_far_past_its_size() {
    let key = new_key();
    for (size, extra) in [
        (0, 1),
        (40, 1),
        (40, CHUNK),
        (CHUNK, 1),
        (CHUNK - 1, 1),
        (2 * CHUNK, 3 * CHUNK),
    ] {
        let original = pattern(size, 7);
        let t = content("ext", &[("a", original.clone(), false)], &key);
        let mut b = original.clone();
        b.extend(pattern(extra, 8));
        fs::write(t.join("src/a"), &b).unwrap();
        match run(&t, &key) {
            // Stops within one chunk of the listed size.
            Err(Error::SizeMismatch {
                expected, found, ..
            }) => {
                assert_eq!(expected, size as u64);
                assert!(
                    found > expected && found <= expected + CHUNK as u64,
                    "read {found} of {size}+{extra}"
                );
            }
            other => panic!("{size}+{extra}: {other:?}"),
        }
        assert_nothing_left(&t);
    }
}

#[test]
fn an_empty_file_listed_with_content_is_refused_and_content_listed_as_empty_too() {
    let key = new_key();
    let t = content("empty1", &[("a", Vec::new(), false)], &key);
    fs::write(t.join("src/a"), b"x").unwrap();
    assert!(matches!(run(&t, &key), Err(Error::SizeMismatch { .. })));
    let t = content("empty2", &[("a", b"x".to_vec(), false)], &key);
    fs::write(t.join("src/a"), b"").unwrap();
    assert!(matches!(run(&t, &key), Err(Error::SizeMismatch { .. })));
}

#[test]
fn a_listed_file_that_is_a_symlink_is_refused_even_to_identical_bytes() {
    let key = new_key();
    let t = content("link", &[("host/main.mjs", b"same".to_vec(), false)], &key);
    let src = t.join("src");
    fs::write(src.join("elsewhere"), b"same").unwrap();
    fs::remove_file(src.join("host/main.mjs")).unwrap();
    symlink("../elsewhere", src.join("host/main.mjs")).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::Symlink(p)) if p == "host/main.mjs"));
    assert_nothing_left(&t);
}

#[test]
fn a_folder_on_the_way_to_a_listed_file_that_is_a_symlink_is_refused() {
    let key = new_key();
    for depth in [0usize, 1, 2] {
        let parts = ["a", "b", "c"];
        let rel = format!("{}/f", parts.join("/"));
        let t = content("dirlink", &[(rel.as_str(), b"f".to_vec(), false)], &key);
        let src = t.join("src");
        // Move the real folder at `depth` aside and put a symlink to it in its place.
        let link = src.join(parts[..=depth].join("/"));
        let real = t.join(&format!("real{depth}"));
        fs::rename(&link, &real).unwrap();
        symlink(&real, &link).unwrap();
        assert!(
            fs::read(src.join(&rel)).is_ok(),
            "the path still resolves through the link"
        );
        assert!(
            matches!(run(&t, &key), Err(Error::Symlink(_))),
            "depth {depth}"
        );
        assert_nothing_left(&t);
    }
}

#[test]
fn the_source_folder_itself_may_be_reached_through_a_symlink() {
    let key = new_key();
    let t = content("rootlink", &[("a", b"a".to_vec(), false)], &key);
    symlink(t.join("src"), t.join("via")).unwrap();
    verify_and_copy(
        &t.join("via"),
        &t.join("dest"),
        &[trusted("current", &key)],
        &expect(),
    )
    .unwrap();
    assert_eq!(fs::read(t.join("dest/a")).unwrap(), b"a");
}

#[test]
fn a_listed_path_that_is_a_folder_or_a_fifo_is_refused_without_waiting() {
    let key = new_key();
    let t = content("dir", &[("a", b"a".to_vec(), false)], &key);
    fs::remove_file(t.join("src/a")).unwrap();
    fs::create_dir(t.join("src/a")).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::NotRegularFile(_))));
    assert_nothing_left(&t);

    let t = content("fifo", &[("a", b"a".to_vec(), false)], &key);
    fs::remove_file(t.join("src/a")).unwrap();
    let c = std::ffi::CString::new(t.join("src/a").to_str().unwrap()).unwrap();
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    // A FIFO opened for reading without O_NONBLOCK would block here until a writer appeared.
    assert!(matches!(run(&t, &key), Err(Error::NotRegularFile(_))));
    assert_nothing_left(&t);

    // And a FIFO where a folder on the way should be.
    let t = content("fifodir", &[("a/b", b"b".to_vec(), false)], &key);
    fs::remove_dir_all(t.join("src/a")).unwrap();
    let c = std::ffi::CString::new(t.join("src/a").to_str().unwrap()).unwrap();
    // SAFETY: a valid C string.
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
    assert!(matches!(run(&t, &key), Err(Error::NotRegularFile(_))));
    assert_nothing_left(&t);
}

#[test]
fn a_listed_file_missing_from_the_source_is_refused() {
    let key = new_key();
    let t = content(
        "missing",
        &[("a", b"a".to_vec(), false), ("b/c", b"c".to_vec(), false)],
        &key,
    );
    fs::remove_file(t.join("src/b/c")).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::Io { .. })));
    assert_nothing_left(&t);
}

#[test]
fn a_missing_manifest_or_signature_is_refused() {
    let key = new_key();
    for name in [MANIFEST_NAME, SIGNATURE_NAME] {
        let t = content("nosig", &[("a", b"a".to_vec(), false)], &key);
        fs::remove_file(t.join("src").join(name)).unwrap();
        assert!(matches!(run(&t, &key), Err(Error::Missing(n)) if n == name));
        assert_nothing_left(&t);
    }
}

#[test]
fn a_manifest_or_signature_that_is_a_symlink_a_folder_or_too_large_is_refused() {
    let key = new_key();
    for name in [MANIFEST_NAME, SIGNATURE_NAME] {
        let t = content("badfile", &[("a", b"a".to_vec(), false)], &key);
        let p = t.join("src").join(name);
        fs::rename(&p, t.join("moved")).unwrap();
        symlink(t.join("moved"), &p).unwrap();
        assert!(
            matches!(
                run(&t, &key),
                Err(Error::BadFile {
                    reason: "is a symlink",
                    ..
                })
            ),
            "{name}"
        );

        fs::remove_file(&p).unwrap();
        fs::create_dir(&p).unwrap();
        assert!(
            matches!(
                run(&t, &key),
                Err(Error::BadFile {
                    reason: "is not a regular file",
                    ..
                })
            ),
            "{name}"
        );

        fs::remove_dir(&p).unwrap();
        let limit = if name == MANIFEST_NAME {
            content_verify::MAX_MANIFEST_BYTES
        } else {
            content_verify::MAX_SIGNATURE_BYTES
        };
        fs::File::create(&p).unwrap().set_len(limit + 1).unwrap();
        assert!(
            matches!(
                run(&t, &key),
                Err(Error::BadFile {
                    reason: "is too large",
                    ..
                })
            ),
            "{name}"
        );
        assert_nothing_left(&t);
    }
}

#[test]
fn a_tampered_signature_or_manifest_copies_nothing() {
    let key = new_key();
    let t = content("tamper", &[("a", b"a".to_vec(), false)], &key);
    let m = t.join("src").join(MANIFEST_NAME);
    let mut b = fs::read(&m).unwrap();
    let last = b.len() - 2;
    b[last] ^= 0x20;
    fs::write(&m, &b).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::BadSignature)));
    assert_nothing_left(&t);

    let t = content("tamper2", &[("a", b"a".to_vec(), false)], &key);
    assert!(matches!(
        verify_and_copy(
            &t.join("src"),
            &t.join("dest"),
            &[trusted("current", &new_key())],
            &expect()
        ),
        Err(Error::UnknownKey(_))
    ));
    assert_nothing_left(&t);
}

#[test]
fn an_existing_destination_is_refused_and_left_as_it_was() {
    let key = new_key();
    let t = content("exists", &[("a", b"new".to_vec(), false)], &key);
    let dest = t.join("dest");

    fs::create_dir(&dest).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::DestinationExists(_))));
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    fs::remove_dir(&dest).unwrap();

    fs::write(&dest, b"old").unwrap();
    assert!(matches!(run(&t, &key), Err(Error::DestinationExists(_))));
    assert_eq!(fs::read(&dest).unwrap(), b"old");
    fs::remove_file(&dest).unwrap();

    symlink(t.join("nowhere"), &dest).unwrap();
    assert!(matches!(run(&t, &key), Err(Error::DestinationExists(_))));
    assert!(!t.join("nowhere").exists(), "followed the symlink");
    fs::remove_file(&dest).unwrap();

    run(&t, &key).unwrap();
    assert_eq!(fs::read(dest.join("a")).unwrap(), b"new");
}

#[test]
fn remove_content_removes_a_read_only_copy() {
    let key = new_key();
    let t = content("remove", &[("a/b/c", b"c".to_vec(), true)], &key);
    run(&t, &key).unwrap();
    assert!(
        fs::remove_dir_all(t.join("dest")).is_err(),
        "a copy should be read-only"
    );
    remove_content(&t.join("dest")).unwrap();
    assert!(!t.join("dest").exists());
}
