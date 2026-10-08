//! Installing and upgrading `<data>/shell/Centralu.app` from the shell the window carries
//! (docs/plans/thin-shell.md §6.1).
//!
//! The window carries the shell in `Contents/Resources/shell/Centralu.app`, with `shell.json` beside
//! it: the shell version, the hash of the bundle's files (`tree_hash`) and whether those bytes are the
//! ones `packaging/shell/shell.lock` pins. The release staging (`scripts/bundle-stage.mts`) writes it
//! and checks the pinned zip's sha256 and the bundle's cdhash against the lock before it does.
//!
//! **What is installed when** (`plan`): nothing installed, an installed bundle that cannot be read,
//! or one of a lower shell version, is replaced by the carried one. A higher installed version is
//! never replaced by a lower one. At the same version, the carried bundle replaces the installed one
//! only when the carried bytes are pinned and the installed bytes differ: then the installed one is a
//! local build's or a damaged one, and the pinned bytes are the ones people's permissions belong to.
//! An unpinned carried shell never replaces one of its own version.
//!
//! **How** (`install`): copy to `<data>/shell/.Centralu.app.new`, hash the copy and compare it with
//! the carried hash, rename the installed bundle aside to `.Centralu.app.old`, rename the new one in.
//! If the last rename fails the old one is renamed back. The old one is removed only once the new
//! shell has started a keeper (`finish`); a window that finds the installed bundle missing and an
//! old one aside (it stopped between the two renames) puts the old one back (`recover`). A failed
//! step leaves the installed shell as it was.

use std::fs::{self, DirBuilder};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The shell bundle's name, in the window's resources and in `<data>/shell/`.
pub const SHELL_APP: &str = "Centralu.app";
/// Beside the carried bundle: `{ "format": 1, "version", "tree", "pinned" }`.
pub const DESCRIPTOR: &str = "shell.json";
const NEW: &str = ".Centralu.app.new";
const OLD: &str = ".Centralu.app.old";

/// `<data>/shell/`.
pub fn shell_dir(data: &Path) -> PathBuf {
    data.join("shell")
}

/// The shell the window carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Carried {
    pub app: PathBuf,
    pub version: u64,
    /// `tree_hash` of the bundle as the release staged it.
    pub tree: String,
    /// The bytes are the ones shell.lock pins (a release); false for a local or rehearsal build.
    pub pinned: bool,
}

/// What is installed in `<data>/shell/`, as far as the plan needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Installed {
    None,
    /// A bundle is there but its version or its files cannot be read.
    Unreadable,
    Shell { version: u64, tree: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Copy the carried shell in, replacing whatever is there.
    Install,
    /// Leave the installed shell alone and open it.
    Keep,
}

/// The install decision table (module docs).
pub fn plan(carried: &Carried, installed: &Installed) -> Plan {
    match installed {
        Installed::None | Installed::Unreadable => Plan::Install,
        Installed::Shell { version, .. } if *version < carried.version => Plan::Install,
        Installed::Shell { version, .. } if *version > carried.version => Plan::Keep,
        Installed::Shell { tree, .. } if carried.pinned && *tree != carried.tree => Plan::Install,
        Installed::Shell { .. } => Plan::Keep,
    }
}

/// Reads the carried shell from the window's resources (`Contents/Resources`). `None` when the bundle
/// carries no shell at all; an error when it carries one that does not match its own description.
pub fn read_carried(resources: &Path) -> Result<Option<Carried>, String> {
    let dir = resources.join("shell");
    let descriptor = dir.join(DESCRIPTOR);
    let app = dir.join(SHELL_APP);
    if !descriptor.exists() && !app.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&descriptor).map_err(|e| format!("cannot read {}: {e}", descriptor.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", descriptor.display()))?;
    if v.get("format").and_then(Value::as_u64) != Some(1) {
        return Err(format!("{} is not format 1", descriptor.display()));
    }
    let version = v.get("version").and_then(Value::as_u64).filter(|n| *n >= 1).ok_or_else(|| format!("{} has no version", descriptor.display()))?;
    let tree = v
        .get("tree")
        .and_then(Value::as_str)
        .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        .ok_or_else(|| format!("{} has no tree hash", descriptor.display()))?
        .to_string();
    let pinned = v.get("pinned").and_then(Value::as_bool).unwrap_or(false);
    match bundle_version(&app) {
        Some(n) if n == version => {}
        other => return Err(format!("the carried shell says version {other:?} in its Info.plist, {version} in {DESCRIPTOR}")),
    }
    Ok(Some(Carried { app, version, tree, pinned }))
}

/// What is installed at `<shell_dir>/Centralu.app`.
pub fn installed(shell_dir: &Path) -> Installed {
    let app = shell_dir.join(SHELL_APP);
    if fs::symlink_metadata(&app).is_err() {
        return Installed::None;
    }
    match (bundle_version(&app), tree_hash(&app)) {
        (Some(version), Ok(tree)) => Installed::Shell { version, tree },
        _ => Installed::Unreadable,
    }
}

/// `CentraluShellVersion` in a shell bundle's Info.plist (an `<integer>`), read as text: the
/// shell's Info.plist is an XML plist written by hand (shell/Info.plist).
pub fn bundle_version(app: &Path) -> Option<u64> {
    let text = fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
    let after = &text[text.find("<key>CentraluShellVersion</key>")? + "<key>CentraluShellVersion</key>".len()..];
    let after = after.trim_start().strip_prefix("<integer>")?;
    after[..after.find("</integer>")?].trim().parse().ok().filter(|n| *n >= 1)
}

/**
 * The hash of a bundle's files: SHA-256 over one line per regular file, sorted by the bytes of its
 * path relative to the bundle (`/`-separated), each `<x|-> <sha256 of the file> <path>\n`, `x` when
 * any execute bit is set. Folders are implied by the files in them. A symlink, any other kind of
 * file, or a path with a control character is an error: a shell bundle has none, and refusing them
 * keeps the copy's hash a statement about bytes alone. `scripts/bundle-stage.mts` (`treeHash`)
 * computes the same; both are tested against the same fixed tree.
 */
pub fn tree_hash(app: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    walk(app, "", &mut files)?;
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut all = Sha256::new();
    for (rel, path, exec) in files {
        let mut h = Sha256::new();
        let mut f = fs::File::open(&path)?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        all.update(format!("{} {} {rel}\n", if exec { 'x' } else { '-' }, hex(&h.finalize())).as_bytes());
    }
    Ok(hex(&all.finalize()))
}

fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf, bool)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| bad(format!("a file name in {} is not UTF-8", dir.display())))?;
        if name.chars().any(char::is_control) {
            return Err(bad(format!("{name:?} in {} has a control character", dir.display())));
        }
        let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_dir() {
            walk(&entry.path(), &rel, out)?;
        } else if meta.is_file() {
            out.push((rel, entry.path(), meta.permissions().mode() & 0o111 != 0));
        } else {
            return Err(bad(format!("{rel} is not a regular file or a folder")));
        }
    }
    Ok(())
}

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The steps of `install`, so a test can make any one of them fail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Copy,
    SetAside,
    RenameIn,
}

/// What `install` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Swapped {
    /// A previous shell was renamed aside and waits for `finish`.
    pub old_aside: bool,
}

/// Installs `carried` into `shell_dir` (module docs). On any error the installed shell, if there was
/// one, is still at `<shell_dir>/Centralu.app`, and nothing new is left behind.
pub fn install(carried: &Carried, shell_dir: &Path) -> Result<Swapped, String> {
    install_with(carried, shell_dir, &|_| Ok(()))
}

/// `install`, with `fail` asked before each step (tests make it fail one).
pub fn install_with(carried: &Carried, shell_dir: &Path, fail: &dyn Fn(Step) -> io::Result<()>) -> Result<Swapped, String> {
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(shell_dir)
        .map_err(|e| format!("cannot create {}: {e}", shell_dir.display()))?;
    let target = shell_dir.join(SHELL_APP);
    let new = shell_dir.join(NEW);
    let old = shell_dir.join(OLD);
    remove_any(&new).map_err(|e| format!("cannot remove a leftover {}: {e}", new.display()))?;

    let copied = fail(Step::Copy).and_then(|()| copy_tree(&carried.app, &new));
    if let Err(e) = copied {
        let _ = remove_any(&new);
        return Err(format!("could not copy the shell into {}: {e}", new.display()));
    }
    match tree_hash(&new) {
        Ok(h) if h == carried.tree => {}
        Ok(h) => {
            let _ = remove_any(&new);
            return Err(format!("the copied shell hashes to {h}, not {} as the window carries it", carried.tree));
        }
        Err(e) => {
            let _ = remove_any(&new);
            return Err(format!("could not read back the copied shell: {e}"));
        }
    }

    let had_one = fs::symlink_metadata(&target).is_ok();
    if had_one {
        let aside = fail(Step::SetAside).and_then(|()| remove_any(&old)).and_then(|()| fs::rename(&target, &old));
        if let Err(e) = aside {
            let _ = remove_any(&new);
            return Err(format!("could not move the installed shell aside: {e}"));
        }
    }
    if let Err(e) = fail(Step::RenameIn).and_then(|()| fs::rename(&new, &target)) {
        if had_one {
            let _ = fs::rename(&old, &target);
        }
        let _ = remove_any(&new);
        return Err(format!("could not move the new shell into {}: {e}", target.display()));
    }
    Ok(Swapped { old_aside: had_one })
}

/// After the installed shell started a keeper: the one an upgrade moved aside is no longer needed.
/// Returns whether there was one.
pub fn finish(shell_dir: &Path) -> bool {
    let old = shell_dir.join(OLD);
    fs::symlink_metadata(&old).is_ok() && remove_any(&old).is_ok()
}

/// A window that stopped between `install`'s two renames left no installed shell and the old one
/// aside: put it back. Returns whether it did.
pub fn recover(shell_dir: &Path) -> bool {
    let target = shell_dir.join(SHELL_APP);
    let old = shell_dir.join(OLD);
    if fs::symlink_metadata(&target).is_err() && fs::symlink_metadata(&old).is_ok() {
        return fs::rename(&old, &target).is_ok();
    }
    false
}

/// Copies files and folders with their permission bits and nothing else: no extended attributes (a
/// quarantine flag on the window's bundle must not follow the shell), no symlinks (refused).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    DirBuilder::new().mode(0o755).create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        let dest = to.join(entry.file_name());
        if meta.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else if meta.is_file() {
            let mut src = fs::File::open(entry.path())?;
            let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&dest)?;
            io::copy(&mut src, &mut out)?;
            out.sync_all()?;
            fs::set_permissions(&dest, fs::Permissions::from_mode(meta.permissions().mode() & 0o777))?;
        } else {
            return Err(bad(format!("{} is not a regular file or a folder", entry.path().display())));
        }
    }
    fs::set_permissions(to, fs::Permissions::from_mode(fs::metadata(from)?.permissions().mode() & 0o777))
}

fn remove_any(p: &Path) -> io::Result<()> {
    match fs::symlink_metadata(p) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => {
            // A copy this module made may hold read-only folders; make them writable to remove them.
            make_writable(p);
            fs::remove_dir_all(p)
        }
        Ok(_) => fs::remove_file(p),
    }
}

fn make_writable(dir: &Path) {
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            if fs::symlink_metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false) {
                make_writable(&e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests;
