//! Copying verified content into place (Unix).
//!
//! The order is what makes this safe, so it is spelled out:
//!
//! 1. The manifest and the signature are read from the source folder without following a symlink,
//!    and the signature is checked before anything in the manifest is believed.
//! 2. Each listed file is opened by walking its path one component at a time with `openat` and
//!    `O_NOFOLLOW`, so no component can be a symlink, and `fstat` on that descriptor must say
//!    regular file. The bytes are read **once**, from that descriptor, and each chunk is hashed and
//!    written to the copy in the same step. There is no check of one file followed by use of
//!    another: what was hashed is exactly what was copied.
//! 3. The copy goes into a fresh folder beside the destination (created `0700`, so no other user can
//!    write into it), is read back and hashed again, made read-only, and only then renamed onto the
//!    destination with a rename that refuses to replace anything. A refusal at any point removes the
//!    partial folder; the destination either does not exist or holds all of it.
//!
//! What this does not protect against: another process of the same user, which can change the copy
//! after this returns as it can change anything else of that user's (thin-shell.md §4).

use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs::{self, DirBuilder, File, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::manifest::verify_manifest;
use crate::{
    Error, Expect, FileEntry, Manifest, Result, TrustedKey, MANIFEST_NAME, MAX_MANIFEST_BYTES,
    MAX_SIGNATURE_BYTES, SIGNATURE_NAME,
};

const CHUNK: usize = 256 * 1024;

/// Verify the content in `source_dir` against `keys` and `expect`, and copy what it lists to
/// `dest_dir`, which must not exist yet. The manifest and its signature are copied too, so the
/// copy can be verified again later. Returns the manifest that was verified.
pub fn verify_and_copy(
    source_dir: &Path,
    dest_dir: &Path,
    keys: &[TrustedKey],
    expect: &Expect,
) -> Result<Manifest> {
    // The source folder itself may be reached through a symlink (`/tmp` and `/var` are symlinks on
    // macOS); only what is below it is held to the no-symlink rule.
    let root = open_dir(source_dir)?;
    let manifest_bytes = read_small(&root, MANIFEST_NAME, MAX_MANIFEST_BYTES)?;
    let signature_bytes = read_small(&root, SIGNATURE_NAME, MAX_SIGNATURE_BYTES)?;
    let manifest = verify_manifest(&manifest_bytes, &signature_bytes, keys, expect)?;

    if fs::symlink_metadata(dest_dir).is_ok() {
        return Err(Error::DestinationExists(dest_dir.to_path_buf()));
    }
    let partial = make_partial_dir(dest_dir)?;
    let result = fill(
        &root,
        &manifest,
        &partial,
        &manifest_bytes,
        &signature_bytes,
        &|_| (),
    )
    .and_then(|()| rename_no_replace(&partial, dest_dir));
    if result.is_err() {
        let _ = remove_content(&partial);
    }
    result.map(|()| manifest)
}

/// Remove a content folder this crate wrote. Its folders are read-only, so a plain recursive
/// remove fails on them; this gives the owner write permission back first. Symlinks are not
/// followed.
pub fn remove_content(dir: &Path) -> io::Result<()> {
    fn writable(p: &Path) -> io::Result<()> {
        if fs::symlink_metadata(p)?.is_dir() {
            fs::set_permissions(p, Permissions::from_mode(0o700))?;
            for entry in fs::read_dir(p)? {
                writable(&entry?.path())?;
            }
        }
        Ok(())
    }
    writable(dir)?;
    fs::remove_dir_all(dir)
}

/// `before_read_back` runs between writing the copy and reading it back; only the tests give it
/// anything to do.
fn fill(
    root: &OwnedFd,
    manifest: &Manifest,
    partial: &Path,
    manifest_bytes: &[u8],
    signature_bytes: &[u8],
    before_read_back: &dyn Fn(&Path),
) -> Result<()> {
    let mut dirs = BTreeSet::new();
    for entry in &manifest.files {
        if let Some((parent, _)) = entry.path.rsplit_once('/') {
            let mut acc = String::new();
            for part in parent.split('/') {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(part);
                if dirs.insert(acc.clone()) {
                    DirBuilder::new()
                        .mode(0o700)
                        .create(partial.join(&acc))
                        .or_else(|e| {
                            if e.kind() == io::ErrorKind::AlreadyExists {
                                Ok(())
                            } else {
                                Err(e)
                            }
                        })
                        .map_err(|e| Error::io(format!("create {acc}"), e))?;
                }
            }
        }
        copy_one(root, entry, &partial.join(&entry.path))?;
    }
    for (name, bytes) in [
        (MANIFEST_NAME, manifest_bytes),
        (SIGNATURE_NAME, signature_bytes),
    ] {
        let mut f =
            create_new(&partial.join(name)).map_err(|e| Error::io(format!("write {name}"), e))?;
        f.write_all(bytes)
            .and_then(|()| f.sync_all())
            .and_then(|()| f.set_permissions(Permissions::from_mode(0o444)))
            .map_err(|e| Error::io(format!("write {name}"), e))?;
    }

    before_read_back(partial);
    // Read every copy back. The bytes were hashed on the way in; this catches the copy being
    // changed or lost between the write and here.
    let copy_root = open_dir(partial)?;
    for entry in &manifest.files {
        let mut f = open_beneath(&copy_root, &entry.path)?;
        let (size, hash) = hash_all(&mut f, entry)?;
        if size != entry.size || hash != entry.sha256 {
            return Err(Error::CopyMismatch(entry.path.clone()));
        }
    }

    // Deepest first, so a parent is not made read-only before its children are done.
    let mut ordered: Vec<&String> = dirs.iter().collect();
    ordered.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for d in ordered {
        let p = partial.join(d);
        File::open(&p)
            .and_then(|f| f.sync_all())
            .map_err(|e| Error::io(format!("sync {d}"), e))?;
        fs::set_permissions(&p, Permissions::from_mode(0o555))
            .map_err(|e| Error::io(format!("chmod {d}"), e))?;
    }
    // The top folder too, before the rename: a rename within one parent does not need write
    // permission on the folder moved, and a chmod after the rename could fail with the copy
    // already in place.
    File::open(partial)
        .and_then(|f| f.sync_all())
        .map_err(|e| Error::io("sync the copy", e))?;
    fs::set_permissions(partial, Permissions::from_mode(0o555))
        .map_err(|e| Error::io("chmod the copy", e))
}

fn copy_one(root: &OwnedFd, entry: &FileEntry, dest: &Path) -> Result<()> {
    let mut src = open_beneath(root, &entry.path)?;
    let mut out =
        create_new(dest).map_err(|e| Error::io(format!("create the copy of {}", entry.path), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total: u64 = 0;
    loop {
        let n = match src.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(Error::io(format!("read {}", entry.path), e)),
        };
        total += n as u64;
        // Stop at the first byte past the listed size: a file that grows (or never ends) is not
        // read to its end.
        if total > entry.size {
            return Err(Error::SizeMismatch {
                path: entry.path.clone(),
                expected: entry.size,
                found: total,
            });
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])
            .map_err(|e| Error::io(format!("write the copy of {}", entry.path), e))?;
    }
    if total != entry.size {
        return Err(Error::SizeMismatch {
            path: entry.path.clone(),
            expected: entry.size,
            found: total,
        });
    }
    if <[u8; 32]>::from(hasher.finalize()) != entry.sha256 {
        return Err(Error::HashMismatch(entry.path.clone()));
    }
    let mode = if entry.executable { 0o555 } else { 0o444 };
    out.sync_all()
        .and_then(|()| out.set_permissions(Permissions::from_mode(mode)))
        .map_err(|e| Error::io(format!("finish the copy of {}", entry.path), e))
}

fn hash_all(f: &mut File, entry: &FileEntry) -> Result<(u64, [u8; 32])> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total += n as u64;
                if total > entry.size {
                    return Err(Error::CopyMismatch(entry.path.clone()));
                }
                hasher.update(&buf[..n]);
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(Error::io(format!("read back {}", entry.path), e)),
        }
    }
    Ok((total, hasher.finalize().into()))
}

fn create_new(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn cstr(s: &[u8], what: &str) -> Result<CString> {
    CString::new(s).map_err(|_| Error::BadPath {
        path: what.to_string(),
        reason: "contains a NUL byte",
    })
}

fn open_dir(path: &Path) -> Result<OwnedFd> {
    let c = cstr(path.as_os_str().as_bytes(), &path.display().to_string())?;
    // SAFETY: `c` is a valid NUL-terminated string; the returned descriptor is owned below.
    let fd = unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(Error::io(
            format!("open {}", path.display()),
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: `fd` was just returned by open and is owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Open `rel` below `root` without following a symlink at any component, and only if it is a
/// regular file. Every component is resolved from the descriptor of the one before, so nothing can
/// swap a component for a symlink between a check and the open.
fn open_beneath(root: &OwnedFd, rel: &str) -> Result<File> {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut owned: Option<OwnedFd> = None;
    for (i, part) in parts.iter().enumerate() {
        let dirfd = owned.as_ref().unwrap_or(root).as_raw_fd();
        let last = i == parts.len() - 1;
        let c = cstr(part.as_bytes(), rel)?;
        // O_NONBLOCK on the last component: opening a FIFO for reading would otherwise wait for a
        // writer forever. It changes nothing for a regular file.
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: `dirfd` is an open directory descriptor and `c` a valid C string.
        let fd = unsafe { libc::openat(dirfd, c.as_ptr(), flags) };
        if fd < 0 {
            let err = io::Error::last_os_error();
            return Err(classify(dirfd, &c, rel, err));
        }
        // SAFETY: `fd` was just returned by openat and is owned by nobody else.
        owned = Some(unsafe { OwnedFd::from_raw_fd(fd) });
    }
    let file = File::from(owned.expect("a checked path has at least one component"));
    let meta = file
        .metadata()
        .map_err(|e| Error::io(format!("stat {rel}"), e))?;
    if !meta.file_type().is_file() {
        return Err(Error::NotRegularFile(rel.to_string()));
    }
    Ok(file)
}

/// Turn a failed `openat` into the refusal it stands for. Only the message depends on this: the
/// open has already failed.
fn classify(dirfd: libc::c_int, name: &CString, rel: &str, err: io::Error) -> Error {
    // SAFETY: zeroed `stat` is a valid out-parameter; `dirfd` and `name` are valid.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::fstatat(dirfd, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) };
    if r == 0 {
        match st.st_mode & libc::S_IFMT {
            libc::S_IFLNK => return Error::Symlink(rel.to_string()),
            libc::S_IFDIR => {}
            _ => return Error::NotRegularFile(rel.to_string()),
        }
    }
    Error::io(format!("open {rel}"), err)
}

fn read_small(root: &OwnedFd, name: &'static str, max: u64) -> Result<Vec<u8>> {
    let mut f = match open_beneath(root, name) {
        Ok(f) => f,
        Err(Error::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            return Err(Error::Missing(name))
        }
        Err(Error::Symlink(_)) => {
            return Err(Error::BadFile {
                name,
                reason: "is a symlink",
            })
        }
        Err(Error::NotRegularFile(_)) => {
            return Err(Error::BadFile {
                name,
                reason: "is not a regular file",
            })
        }
        Err(e) => return Err(e),
    };
    let mut bytes = Vec::new();
    (&mut f)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| Error::io(format!("read {name}"), e))?;
    if bytes.len() as u64 > max {
        return Err(Error::BadFile {
            name,
            reason: "is too large",
        });
    }
    Ok(bytes)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A new, empty, owner-only folder beside `dest`, named so it is hidden and recognisable.
fn make_partial_dir(dest: &Path) -> Result<PathBuf> {
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = dest
        .file_name()
        .ok_or_else(|| Error::io("destination", io::ErrorKind::InvalidInput.into()))?;
    loop {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut leaf = std::ffi::OsString::from(".");
        leaf.push(name);
        leaf.push(format!(".partial-{}-{nonce:x}-{n}", std::process::id()));
        let path = parent.join(leaf);
        match DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(Error::io(
                    format!("create a folder in {}", parent.display()),
                    e,
                ))
            }
        }
    }
}

/// Rename `from` onto `to`, failing if `to` exists, also when it appeared after the check in
/// `verify_and_copy`. A plain `rename` would replace an empty folder there.
fn rename_no_replace(from: &Path, to: &Path) -> Result<()> {
    let a = cstr(from.as_os_str().as_bytes(), &from.display().to_string())?;
    let b = cstr(to.as_os_str().as_bytes(), &to.display().to_string())?;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    // SAFETY: both are valid C strings.
    let r = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    // SAFETY: both are valid C strings; AT_FDCWD resolves them like rename(2).
    let r = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
    // Elsewhere there is no exclusive rename; the check in `verify_and_copy` is all there is.
    // SAFETY: both are valid C strings.
    let r = unsafe { libc::rename(a.as_ptr(), b.as_ptr()) };
    if r != 0 {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::AlreadyExists || err.raw_os_error() == Some(libc::ENOTEMPTY)
        {
            return Err(Error::DestinationExists(to.to_path_buf()));
        }
        return Err(Error::io(format!("rename into {}", to.display()), err));
    }
    let _ = File::open(
        to.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .and_then(|f| f.sync_all());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("content-verify-unit-{tag}-{}", std::process::id()));
        let _ = remove_content(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Nothing in the public API can change the copy between the write and the read-back, so the
    /// read-back is tested here, with the hook doing what another writer would.
    #[test]
    fn the_read_back_catches_a_copy_changed_after_it_was_written() {
        let t = temp("readback");
        fs::create_dir(t.join("src")).unwrap();
        fs::write(t.join("src/a"), b"abc").unwrap();
        let manifest = Manifest {
            app_version: "1.0.0".into(),
            platform: "p".into(),
            min_shell_version: 1,
            files: vec![FileEntry {
                path: "a".into(),
                size: 3,
                sha256: Sha256::digest(b"abc").into(),
                executable: false,
            }],
            key_id: String::new(),
        };
        let root = open_dir(&t.join("src")).unwrap();
        for change in [&b"abd"[..], b"ab", b"abcd"] {
            let partial = t.join("partial");
            DirBuilder::new().mode(0o700).create(&partial).unwrap();
            let result = fill(&root, &manifest, &partial, b"{}", b"{}", &|p: &Path| {
                fs::set_permissions(p.join("a"), Permissions::from_mode(0o644)).unwrap();
                fs::write(p.join("a"), change).unwrap();
            });
            assert!(
                matches!(result, Err(Error::CopyMismatch(ref p)) if p == "a"),
                "{change:?}: {result:?}"
            );
            remove_content(&partial).unwrap();
        }
        let ok = t.join("partial");
        DirBuilder::new().mode(0o700).create(&ok).unwrap();
        fill(&root, &manifest, &ok, b"{}", b"{}", &|_| ()).unwrap();
        remove_content(&t).unwrap();
    }

    /// The exclusive rename on its own, without the existence check before it: a folder that
    /// appears at the destination after that check is not replaced.
    #[test]
    fn the_rename_refuses_a_destination_that_appeared_after_the_check() {
        let t = temp("rename");
        fs::create_dir(t.join("from")).unwrap();
        fs::write(t.join("from/x"), b"x").unwrap();
        fs::create_dir(t.join("to")).unwrap();
        assert!(matches!(
            rename_no_replace(&t.join("from"), &t.join("to")),
            Err(Error::DestinationExists(_))
        ));
        assert!(t.join("from/x").exists() && fs::read_dir(t.join("to")).unwrap().count() == 0);
        fs::remove_dir(t.join("to")).unwrap();
        rename_no_replace(&t.join("from"), &t.join("to")).unwrap();
        assert_eq!(fs::read(t.join("to/x")).unwrap(), b"x");
        remove_content(&t).unwrap();
    }
}
