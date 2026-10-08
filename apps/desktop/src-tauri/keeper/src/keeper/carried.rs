//! The keeper and host a Linux window carries, copied out of its AppImage (lesson FI4,
//! docs/plans/runtime-unification.md step 4).
//!
//! An AppImage's files exist only while its runtime keeps the squashfs mounted, and the runtime
//! keeps it mounted only while some process holds its keep-alive pipe (docs/spikes/2026-10-linux-keeper.md
//! §6). A keeper started from inside the mount, or handed over to from inside a newer one, loses its
//! own code when that window quits. So a Linux window copies the `centralu-keeper` beside it and its
//! bundled host into `<data>/content/<version>/`, the layout the shell gives macOS
//! (`{centralu-keeper, host/, content-manifest.json}`), and starts the keeper from the copy, which
//! then runs its host from the copy as it is (`content::version_dir_of`), never from `<data>/hosts/`.
//!
//! **Not verified.** The release signs content for macOS only (`scripts/release-npm.mts`); whether
//! Linux content is signed and verified like macOS's or only copied is the owner's decision 1 of
//! the plan's §8, still open. Until then the copy gets every check that needs no signature: it is
//! written into a `.<version>.partial-*` folder and renamed into place only once complete, its
//! files are hashed after copying and must match the keeper and the build stamp read from the
//! source, the hashes are kept in an unsigned `content-manifest.json` (the signed format, so a
//! verifier refuses it for the missing signature rather than mistaking it for signed), and the
//! folder is made read-only. A folder already there is used only if every file still matches that
//! manifest and it holds the same keeper and build as the source; anything else is copied again,
//! unless something may run from it (`replace` false), when the copy is refused and nothing is
//! touched. `content::Origin` marks a keeper from such a folder `signed: false`.

use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use content_verify::version::Version;
use content_verify::{remove_content, MANIFEST_NAME};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::content::{content_root, version_dir, Refusal, HOST_DIR};
use super::exe::KEEPER_EXE;

/// The host's build stamp, the last file `bundle.mjs` writes: it tells two builds of one version apart.
const BUILD_STAMP: &str = "host/bundle-info.json";

/// What the window carries: its keeper executable, its bundled host folder, and its version.
#[derive(Debug, Clone, Copy)]
pub struct Carried<'a> {
    pub keeper: &'a Path,
    pub host: &'a Path,
    pub version: &'a str,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: u64,
    app_version: String,
    platform: String,
    min_shell_version: u64,
    files: Vec<Entry>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct Entry {
    path: String,
    size: u64,
    sha256: String,
    executable: bool,
}

/**
 * Puts what the window carries into `<data>/content/<version>/` and returns that folder: the copy
 * already there when it is intact and of the same build, else a fresh one. `replace` says whether
 * a folder there that is not may be removed: only when no keeper runs, since a keeper or its host
 * may run from it (refused `in-use` otherwise). `log` hears what was decided.
 */
pub fn place(data: &Path, c: &Carried, replace: bool, log: &dyn Fn(&str)) -> Result<PathBuf, Refusal> {
    if Version::parse(c.version).is_err() {
        return Err(Refusal::new("content", format!("{:?} is not a version a content folder can be named after", c.version)));
    }
    if !c.keeper.is_file() || !c.host.join("main.mjs").is_file() || !c.host.join("bundle-info.json").is_file() {
        return Err(Refusal::new(
            "no-content",
            format!("no keeper at {} or no complete host in {}", c.keeper.display(), c.host.display()),
        ));
    }
    let root = content_root(data);
    let resolve = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let inside = |p: &Path| p.starts_with(&root) || resolve(p).starts_with(resolve(data).join(super::content::CONTENT_DIR));
    if inside(c.keeper) || inside(c.host) {
        return Err(Refusal::new("content", format!("{} is already inside the folder it would be copied into", c.host.display())));
    }
    let read = |p: &Path| hash_file(p).map_err(|e| Refusal::new("content", format!("cannot read {}: {e}", p.display())));
    let want = (read(c.keeper)?, read(&c.host.join("bundle-info.json"))?);

    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .map_err(|e| Refusal::new("copy", format!("cannot create {}: {e}", root.display())))?;
    let dest = version_dir(data, c.version);
    if fs::symlink_metadata(&dest).is_ok() {
        match intact(&dest, &want) {
            Ok(()) => {
                log(&format!("{} holds this build intact; starting from it", dest.display()));
                return Ok(dest);
            }
            Err(why) if !replace => {
                return Err(Refusal::new(
                    "in-use",
                    format!("{} {why}, and a keeper may run from it; restart Centralu completely to start this build", dest.display()),
                ))
            }
            Err(why) => {
                log(&format!("{} {why}; copying again", dest.display()));
                discard(&dest).map_err(|e| Refusal::new("copy", format!("cannot remove {}: {e}", dest.display())))?;
            }
        }
    }

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let tmp = root.join(format!(".{}.partial-{}-{nanos}", c.version, std::process::id()));
    let made = fill(&tmp, c, &want).and_then(|()| {
        fs::rename(&tmp, &dest).map_err(|e| Refusal::new("copy", format!("cannot move the copy into place: {e}")))
    });
    if let Err(r) = made {
        let _ = discard(&tmp);
        // Another window copied the same build meanwhile: its copy serves as well as ours.
        if fs::symlink_metadata(&dest).is_ok() && intact(&dest, &want).is_ok() {
            return Ok(dest);
        }
        return Err(r);
    }
    // Read-only last: a folder its owner cannot write cannot be renamed on macOS 14 (FI8).
    let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o555));
    log(&format!("copied the keeper and host this window carries into {}", dest.display()));
    Ok(dest)
}

/// Copies into `tmp`, hashes the copy, checks it against what was read from the source, writes the
/// manifest and makes everything below `tmp` read-only.
fn fill(tmp: &Path, c: &Carried, want: &(String, String)) -> Result<(), Refusal> {
    let copy = |e: io::Error| Refusal::new("copy", format!("could not copy the keeper and host out of {}: {e}", c.host.display()));
    fs::DirBuilder::new().mode(0o700).create(tmp).map_err(copy)?;
    fs::copy(c.keeper, tmp.join(KEEPER_EXE)).map_err(copy)?;
    super::source::copy_tree(c.host, &tmp.join(HOST_DIR)).map_err(copy)?;
    let mut files = Vec::new();
    list(tmp, tmp, &mut files).map_err(copy)?;
    let sha = |path: &str| files.iter().find(|e| e.path == path).map(|e| e.sha256.clone());
    if sha(KEEPER_EXE).as_ref() != Some(&want.0) || sha(BUILD_STAMP).as_ref() != Some(&want.1) {
        return Err(Refusal::new("content", format!("the build at {} changed while it was being copied", c.host.display())));
    }
    if !files.iter().any(|e| e.path == KEEPER_EXE && e.executable) {
        return Err(Refusal::new("content", format!("{KEEPER_EXE} lost its executable bit in the copy")));
    }
    let manifest = Manifest {
        format: content_verify::MANIFEST_FORMAT,
        app_version: c.version.to_string(),
        platform: content_verify::current_platform(),
        min_shell_version: 0,
        files,
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| copy(io::Error::other(e)))?;
    fs::write(tmp.join(MANIFEST_NAME), bytes).map_err(copy)?;
    read_only(tmp, false).map_err(copy)
}

/// Whether the folder at `dest` still holds every file its manifest lists, unchanged, and is of the
/// build `want` names. `Err` says what is wrong, for the log and the refusal.
fn intact(dest: &Path, want: &(String, String)) -> Result<(), String> {
    let bytes = fs::read(dest.join(MANIFEST_NAME)).map_err(|e| format!("has no readable {MANIFEST_NAME} ({e})"))?;
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("has an unreadable {MANIFEST_NAME} ({e})"))?;
    let sha = |path: &str| m.files.iter().find(|e| e.path == path).map(|e| e.sha256.clone());
    if sha(KEEPER_EXE).as_ref() != Some(&want.0) || sha(BUILD_STAMP).as_ref() != Some(&want.1) {
        return Err("holds another build".into());
    }
    for e in &m.files {
        if Path::new(&e.path).components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(format!("lists a path outside itself ({})", e.path));
        }
        let path = dest.join(&e.path);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() == e.size => {}
            _ => return Err(format!("does not hold {} as it was copied", e.path)),
        }
        if hash_file(&path).map_err(|err| format!("cannot read {} ({err})", e.path))? != e.sha256 {
            return Err(format!("holds a changed {}", e.path));
        }
    }
    Ok(())
}

/// Every regular file below `dir`, as manifest entries relative to `top`. Symlinks are copied as they
/// are (`source::copy_tree`) and not listed.
fn list(top: &Path, dir: &Path, out: &mut Vec<Entry>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<io::Result<_>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            list(top, &path, out)?;
        } else if kind.is_file() {
            let meta = entry.metadata()?;
            let rel = path.strip_prefix(top).map_err(io::Error::other)?;
            out.push(Entry {
                path: rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                sha256: hash_file(&path)?,
                executable: meta.permissions().mode() & 0o111 != 0,
            });
        }
    }
    Ok(())
}

/// Takes the write bits off every file and folder below `dir` (and `dir` itself when `this`).
fn read_only(dir: &Path, this: bool) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            read_only(&entry.path(), true)?;
        } else if kind.is_file() {
            let mode = entry.metadata()?.permissions().mode();
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(mode & 0o555))?;
        }
    }
    if this {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o555))?;
    }
    Ok(())
}

fn hash_file(path: &Path) -> io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Removes a folder this module wrote (read-only inside), or whatever else is at `dest`.
fn discard(dest: &Path) -> io::Result<()> {
    if fs::symlink_metadata(dest)?.is_dir() {
        remove_content(dest)
    } else {
        fs::remove_file(dest)
    }
}

#[cfg(test)]
mod tests;
