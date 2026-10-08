//! Verified content, from the keeper's side (docs/plans/thin-shell.md §4, §5, §10 step 5).
//!
//! A macOS release starts its keeper through the shell, which verifies the window's signed content,
//! copies it into `<data>/content/<version>/` and starts `centralu-keeper` from that copy. Such a
//! keeper and everything it starts are judged by macOS as the shell, so they must only ever run code
//! the project signed. On an update the window asks the running keeper to switch to its build, naming
//! the new bundle's keeper executable; a keeper that runs from verified content does not start that
//! executable. It verifies the new bundle's `Contents/Resources/content` with the same code and keys
//! as the shell, copies it into `<data>/content/<new version>/`, and hands over to the keeper inside
//! that copy, whose host runs from the copy too (`server::move_to_content`). The shell is not
//! involved, which is why its own code can stay small.
//!
//! A keeper started any other way (`Origin::Direct`: a debug build, the window's fallback when
//! the shell refused or is missing) hands over to the executable it is given, as it always did. So
//! does a keeper from an unsigned copy (`Origin::Content` with `signed: false`): a Linux window
//! copies what its AppImage carries into `<data>/content/<version>/` itself (`carried.rs`), because
//! the release signs no Linux content yet (runtime-unification plan §8, decision 1), and names the
//! keeper in its copy on a switch.
//!
//! The rules are the shell's, so that a handoff accepts exactly what a fresh start through the shell
//! would: the signature against the built-in keys (`keys.rs`), the platform, a keeper executable and a
//! host in the content, and the downgrade floor `<data>/content/highest-started`. Not the minimum shell
//! version: the running keeper is not a shell, and a content that needs a newer one is the window's to
//! decide about (§6). A downgrade is refused: an explicit rollback goes through the shell (`--rollback`
//! on a fresh start), never through a handoff (§10.3).

use std::fs;
use std::path::{Component, Path, PathBuf};

use content_verify::version::{check_not_downgrade, read_highest_seen, Rollback, Version};
use content_verify::{read_verified_manifest, remove_content, verify_and_copy, verify_in_place, Error, Expect, Manifest, TrustedKey};

use super::exe::KEEPER_EXE;

/// `<data>/content/`: one folder per app version, each a verified, read-only copy. The shell's
/// `run::CONTENT_DIR`; the shell's tests check the two agree.
pub const CONTENT_DIR: &str = "content";
/// `<data>/content/highest-started`: the downgrade floor (the shell's `run::FLOOR_FILE`).
pub const FLOOR_FILE: &str = "highest-started";
/// Where in the content the host is (the shell's `run::HOST_DIR`).
pub const HOST_DIR: &str = "host";
/// Where a window's bundle carries its signed content, below `Contents/` (thin-shell.md §10.2).
pub const BUNDLE_CONTENT: &str = "Resources/content";

pub fn content_root(data: &Path) -> PathBuf {
    data.join(CONTENT_DIR)
}

pub fn floor_path(data: &Path) -> PathBuf {
    content_root(data).join(FLOOR_FILE)
}

/// `<data>/content/<version>/`. `Version::parse` admits only digits, letters, dots and dashes, never
/// a path, and every caller has a version that parsed.
pub fn version_dir(data: &Path, version: &str) -> PathBuf {
    content_root(data).join(version)
}

/// Where the running keeper's own executable is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// `<data>/content/<version>/centralu-keeper`: started by the shell, or handed to by a keeper that
    /// was, or started by a Linux window from the copy it made. With `signed`, every handoff from
    /// here verifies the next content first.
    Content { dir: PathBuf, version: String, signed: bool },
    /// Anything else: the window's bundle, a debug build, a test's build folder.
    Direct,
}

impl Origin {
    /// This keeper's content folder, never removed while it runs (`source::Copies`).
    pub fn dir(&self) -> Option<&Path> {
        match self {
            Origin::Content { dir, .. } => Some(dir),
            Origin::Direct => None,
        }
    }

    /// Whether a handoff from here takes only signed content (`server::content_route`).
    pub fn signed(&self) -> bool {
        matches!(self, Origin::Content { signed: true, .. })
    }

    /// The same origin where every content folder must be signed: on an OS whose release signs its
    /// content (`start_plan::Os::signs_content`), a folder without a signature is no reason to take
    /// a window's word for the next keeper.
    pub fn requiring_signature(self, required: bool) -> Origin {
        match self {
            Origin::Content { dir, version, signed } => Origin::Content { dir, version, signed: signed || required },
            o => o,
        }
    }
}

/// Where the keeper at `exe` runs from, for the data folder `data`. Both are resolved first, so a
/// data folder reached through a symlink (`/tmp` on macOS) still matches. The folder returned is
/// spelled from `data` as given, as every other path the keeper makes is.
pub fn origin_of(exe: &Path, data: &Path) -> Origin {
    let resolve = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let exe = resolve(exe);
    if exe.file_name().map(|n| n != KEEPER_EXE).unwrap_or(true) {
        return Origin::Direct;
    }
    let Some(dir) = exe.parent() else { return Origin::Direct };
    let Some(version) = dir.file_name().and_then(|v| v.to_str()) else { return Origin::Direct };
    if dir.parent() != Some(content_root(&resolve(data)).as_path()) || Version::parse(version).is_err() {
        return Origin::Direct;
    }
    // Signed content is written by a verifier, which never places a folder without its signature.
    let signed = dir.join(content_verify::SIGNATURE_NAME).is_file();
    Origin::Content { dir: version_dir(data, version), version: version.to_string(), signed }
}

/// The running keeper's own origin.
pub fn own_origin(data: &Path) -> Origin {
    let required = crate::start_plan::Os::current().signs_content();
    match std::env::current_exe() {
        Ok(exe) => origin_of(&exe, data).requiring_signature(required),
        Err(_) => Origin::Direct,
    }
}

/// `<data>/content/<version>/` when `host_dir` is that folder's `host/` (as given, or resolved).
/// Host folders there are verified and read-only: hosts run from them as they are, never from a copy
/// in `<data>/hosts/` (thin-shell.md §5).
pub fn version_dir_of(data: &Path, host_dir: &Path) -> Option<PathBuf> {
    let within = |root: &Path, dir: &Path| -> Option<String> {
        let mut parts = dir.strip_prefix(root).ok()?.components();
        let (Some(Component::Normal(v)), Some(Component::Normal(h)), None) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        let v = v.to_str()?;
        (h == HOST_DIR && Version::parse(v).is_ok()).then(|| v.to_string())
    };
    let version = within(&content_root(data), host_dir).or_else(|| {
        let root = fs::canonicalize(content_root(data)).ok()?;
        within(&root, &fs::canonicalize(host_dir).ok()?)
    })?;
    Some(version_dir(data, &version))
}

/// The signed content a window's bundle carries, found from the executable the window named as its
/// keeper: `<bundle>/Contents/MacOS/<exe>` gives `<bundle>/Contents/Resources/content`. Windows from
/// #444 on name `centralu-keeper`, older ones their own `centralu`; both sit in `Contents/MacOS/`.
pub fn bundle_content_of_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    Some(macos.parent()?.join(BUNDLE_CONTENT))
}

/// The same from a bundle path (`/Applications/Centralu.app`), for a window that named no executable.
pub fn bundle_content_of_bundle(bundle: &Path) -> PathBuf {
    bundle.join("Contents").join(BUNDLE_CONTENT)
}

/// Why the next content was not taken. The ids are the shell's where the meaning is the same
/// (`content`, `downgrade`, `copy`), so the window can say them the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub reason: &'static str,
    pub message: String,
}

impl Refusal {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Refusal {
        Refusal { reason, message: message.into() }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.reason)
    }
}

/// What the check needs from the world, so tests can bring their own keys and platform.
pub struct Verifier<'a> {
    pub keys: &'a [TrustedKey],
    pub platform: String,
    pub log: &'a dyn Fn(&str),
}

impl Verifier<'_> {
    fn expect(&self) -> Expect {
        Expect { platform: self.platform.clone(), shell_version: None }
    }

    /**
     * Reads the content at `src` and checks everything that does not need its files: the signature
     * over the manifest, the platform, that it holds a keeper and a host, and that its version is not
     * below the floor. Nothing is written. Returns the manifest and its exact bytes.
     */
    pub fn check(&self, data: &Path, src: &Path) -> Result<(Manifest, Vec<u8>), Refusal> {
        if !fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) {
            return Err(Refusal::new("no-content", format!("the new build carries no signed content at {}", src.display())));
        }
        // Never take content from under `<data>/content/`: a copy found not to verify is removed
        // before copying again (`place`), and that must not be the source itself.
        let resolve = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if src.starts_with(content_root(data)) || resolve(src).starts_with(content_root(&resolve(data))) {
            return Err(Refusal::new("content", format!("{} is inside the folder the keeper copies into", src.display())));
        }
        let (manifest, bytes) = read_verified_manifest(src, self.keys, &self.expect()).map_err(|e| refusal(e, src, Stage::Source))?;
        let has = |path: &str, exe: bool| manifest.files.iter().any(|f| f.path == path && (!exe || f.executable));
        if !has(KEEPER_EXE, true) {
            return Err(Refusal::new("content", format!("the new build's content has no executable {KEEPER_EXE}")));
        }
        if !has(&format!("{HOST_DIR}/main.mjs"), false) {
            return Err(Refusal::new("content", format!("the new build's content has no {HOST_DIR}/main.mjs")));
        }
        let floor = floor_path(data);
        // As the shell: an unreadable floor is said and ignored, not a reason to refuse every update.
        let highest = read_highest_seen(&floor).unwrap_or_else(|e| {
            (self.log)(&format!("ignoring an unreadable {}: {e}", floor.display()));
            None
        });
        check_not_downgrade(&manifest.app_version, highest.as_deref(), Rollback::Refuse).map_err(|e| match e {
            Error::Downgrade { candidate, highest } => Refusal::new(
                "downgrade",
                format!("Centralu {candidate} is older than {highest}, which has already run here; an older version starts only when rolled back on purpose"),
            ),
            other => Refusal::new("content", other.to_string()),
        })?;
        Ok((manifest, bytes))
    }

    /**
     * Puts the content `check` read into `<data>/content/<version>/` and returns that folder: the copy
     * already there when it verifies where it is and holds the same signed manifest, else a fresh
     * copy. A folder there that does not verify, or holds another signed manifest, is removed and
     * copied again, unless `in_use` (a keeper or host runs from it, or a swap or handoff holds it):
     * then the update is refused, and nothing anything runs from is touched.
     */
    pub fn place(&self, data: &Path, src: &Path, manifest: &Manifest, manifest_bytes: &[u8], in_use: bool) -> Result<PathBuf, Refusal> {
        let root = content_root(data);
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&root)
                .map_err(|e| Refusal::new("copy", format!("cannot create {}: {e}", root.display())))?;
        }
        let dest = version_dir(data, &manifest.app_version);
        let expect = self.expect();
        let differs = |dest: &Path| -> Option<String> {
            match verify_in_place(dest, self.keys, &expect) {
                Ok((_, bytes)) if bytes == manifest_bytes => None,
                Ok(_) => Some("holds a differently signed manifest".to_string()),
                Err(e) => Some(format!("does not verify ({e})")),
            }
        };
        if fs::symlink_metadata(&dest).is_ok() {
            match differs(&dest) {
                None => {
                    (self.log)(&format!("{} verifies; handing over to it", dest.display()));
                    return Ok(dest);
                }
                Some(why) if in_use => {
                    return Err(Refusal::new(
                        "in-use",
                        format!("{} {why}, and something runs from it; restart Centralu completely to start this build", dest.display()),
                    ))
                }
                Some(why) => {
                    (self.log)(&format!("{} {why}; copying again", dest.display()));
                    discard(&dest).map_err(|e| Refusal::new("copy", format!("cannot remove {}: {e}", dest.display())))?;
                }
            }
        }
        match verify_and_copy(src, &dest, self.keys, &expect) {
            Ok(copied) if copied == *manifest => {
                (self.log)(&format!("verified and copied {} files into {}", copied.files.len(), dest.display()));
                Ok(dest)
            }
            Ok(_) => {
                let _ = remove_content(&dest);
                Err(Refusal::new("content", format!("the content at {} changed while it was being copied", src.display())))
            }
            // Something else copied the same version in the meantime: use its copy if it verifies.
            Err(Error::DestinationExists(_)) if differs(&dest).is_none() => Ok(dest),
            Err(e) => Err(refusal(e, src, Stage::Copy)),
        }
    }
}

/// Removes a folder at `dest` the verifier wrote, or whatever else is there (a symlink, a file).
fn discard(dest: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(dest)?.is_dir() {
        remove_content(dest)
    } else {
        fs::remove_file(dest)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    /// Reading the new build's content.
    Source,
    /// Copying it into the data folder.
    Copy,
}

/// The verifier's error as a refusal, worded for the window. The shell's `run::refusal`, without the
/// shell version.
fn refusal(e: Error, src: &Path, stage: Stage) -> Refusal {
    match e {
        Error::Io { ref context, .. } if stage == Stage::Copy && !reads_the_source(context) => {
            Refusal::new("copy", format!("could not copy the new build's content: {e}"))
        }
        Error::DestinationExists(_) => Refusal::new("copy", format!("could not copy the new build's content: {e}")),
        other @ (Error::Missing(_) | Error::Io { .. }) => {
            Refusal::new("content", format!("the new build's content at {} is incomplete or unreadable: {other}", src.display()))
        }
        other => Refusal::new("content", format!("the new build's content at {} is not what the project signed: {other}", src.display())),
    }
}

/// Whether an I/O failure was reading the source rather than writing the copy (the verifier's
/// contexts, as the shell reads them).
fn reads_the_source(context: &str) -> bool {
    !context.starts_with("read back") && (context.starts_with("open ") || context.starts_with("read ") || context.starts_with("stat "))
}

/**
 * Which entries of `<data>/content/` to remove: every version folder not in `keep`, and every
 * `.<version>.partial-*` folder a copy that died left behind (`stale` says which partial folders are
 * old enough to be leftovers; one being written right now belongs to a copy in progress, the shell's
 * or a keeper's). Anything else there (`highest-started`, its temporary files, a stray file) is left
 * alone.
 */
pub fn stale_content(entries: &[(String, bool)], keep: &[String], stale: &dyn Fn(&str) -> bool) -> Vec<String> {
    entries
        .iter()
        .filter(|(name, is_dir)| {
            *is_dir
                && if name.starts_with('.') {
                    name.contains(".partial-") && stale(name)
                } else {
                    Version::parse(name).is_ok() && !keep.iter().any(|k| k == name)
                }
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// Removes what `stale_content` names. Returns what was removed, as `content/<name>`.
pub(super) fn clean(data: &Path, keep: &[PathBuf], stale: &dyn Fn(&Path) -> bool) -> Vec<String> {
    let root = content_root(data);
    let Ok(entries) = fs::read_dir(&root) else { return Vec::new() };
    let entries: Vec<(String, bool)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            // Not followed: a symlink named like a version is not a copy this keeper made.
            Some((name, e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
        })
        .collect();
    let keep: Vec<String> = keep
        .iter()
        .filter(|k| k.parent() == Some(root.as_path()))
        .filter_map(|k| k.file_name()?.to_str().map(str::to_string))
        .collect();
    let mut removed = Vec::new();
    for name in stale_content(&entries, &keep, &|n| stale(&root.join(n))) {
        if remove_content(&root.join(&name)).is_ok() {
            removed.push(format!("{CONTENT_DIR}/{name}"));
        }
    }
    removed
}

#[cfg(test)]
mod tests;
