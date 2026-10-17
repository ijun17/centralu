//! Putting verified content into `<data>/content/<version>/`, the one way the shell and the keeper do
//! it (docs/plans/thin-shell.md §4, §10 step 5): reuse the copy already there when it verifies and was
//! made from the same signed manifest, else remove it and copy again. The words of a refusal stay the
//! caller's (`PlaceError`, `Error::fault`); what is done, and in which order, is decided here once.

use std::fs::{self, DirBuilder};
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

use crate::copy::{remove_content, verify_and_copy, verify_in_place};
use crate::version::Version;
use crate::{Error, Expect, Manifest, TrustedKey};

/// What `place` is asked to do: put the content at `src`, whose verified manifest is `manifest`
/// (read from the exact bytes `manifest_bytes`), into `<root>/<manifest.app_version>/`.
pub struct Placement<'a> {
    /// `<data>/content/`, created (0700) when missing.
    pub root: &'a Path,
    pub src: &'a Path,
    pub manifest: &'a Manifest,
    pub manifest_bytes: &'a [u8],
    pub keys: &'a [TrustedKey],
    pub expect: &'a Expect,
    /// Something runs from the version's folder, so a copy there that does not verify is left alone
    /// and the placement refused (`PlaceError::InUse`) instead of removed.
    pub in_use: bool,
}

/// What `place` did, as it does it, for the caller's log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placing<'a> {
    /// The copy already there verifies and holds the same signed manifest: used as it is.
    Reused(&'a Path),
    /// The folder there does not verify, or holds another manifest (the words): removed, to copy again.
    Replacing(&'a Path, &'a str),
    /// Verified and copied this many files into the folder.
    Copied(&'a Path, usize),
}

/// Why nothing was placed.
#[derive(Debug)]
pub enum PlaceError {
    /// `root` could not be created.
    CreateRoot(PathBuf, io::Error),
    /// The folder there differs (the words), and `in_use` said not to touch it.
    InUse(PathBuf, String),
    /// The folder there differs and could not be removed.
    Remove(PathBuf, io::Error),
    /// The content at `src` changed between reading its manifest and copying it.
    SourceChanged,
    /// Verifying or copying failed; `Error::fault(true)` says whose fault it is.
    Copy(Error),
}

/**
 * Puts the content into `<root>/<version>/` and returns that folder: the copy already there when it
 * verifies where it is and holds the same signed manifest, else a fresh copy. A folder there that does
 * not (or anything else at that name) is removed first, unless `in_use`. When another process copies
 * the same version in the meantime, its copy is used if it verifies. Never runs anything from `src`.
 */
pub fn place(p: &Placement, log: &mut dyn FnMut(Placing)) -> Result<PathBuf, PlaceError> {
    // A version is digits, letters, dots and dashes, digits first: never a path. Verifying the
    // manifest checked it already; again here, since a `Manifest` can also be built by hand.
    Version::parse(&p.manifest.app_version).map_err(PlaceError::Copy)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(p.root)
        .map_err(|e| PlaceError::CreateRoot(p.root.to_path_buf(), e))?;
    let dest = p.root.join(&p.manifest.app_version);
    let differs = |dest: &Path| -> Option<String> {
        match verify_in_place(dest, p.keys, p.expect) {
            Ok((_, bytes)) if bytes == p.manifest_bytes => None,
            Ok(_) => Some("holds a differently signed manifest".to_string()),
            Err(e) => Some(format!("does not verify ({e})")),
        }
    };
    if fs::symlink_metadata(&dest).is_ok() {
        match differs(&dest) {
            None => {
                log(Placing::Reused(&dest));
                return Ok(dest);
            }
            Some(why) if p.in_use => return Err(PlaceError::InUse(dest, why)),
            Some(why) => {
                log(Placing::Replacing(&dest, &why));
                discard(&dest).map_err(|e| PlaceError::Remove(dest.clone(), e))?;
            }
        }
    }
    match verify_and_copy(p.src, &dest, p.keys, p.expect) {
        Ok(copied) if copied == *p.manifest => {
            log(Placing::Copied(&dest, copied.files.len()));
            Ok(dest)
        }
        Ok(_) => {
            let _ = remove_content(&dest);
            Err(PlaceError::SourceChanged)
        }
        Err(Error::DestinationExists(_)) if differs(&dest).is_none() => Ok(dest),
        Err(e) => Err(PlaceError::Copy(e)),
    }
}

/**
 * Removes whatever is at `path`: a folder this crate wrote (read-only inside, `remove_content`), a
 * symlink or a file. Nothing there is not an error. The one way the shell, the keeper and the window
 * remove a copy they made.
 */
pub fn discard(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => remove_content(path),
        Ok(_) => fs::remove_file(path),
    }
}
