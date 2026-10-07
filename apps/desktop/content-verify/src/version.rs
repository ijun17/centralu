//! Refusing a downgrade (thin-shell.md §3 step 4).
//!
//! A signed old release is still signed. Without a floor, anyone who can hand the shell a content
//! folder could hand it an old one with a known bug. The floor is the highest app version this
//! data folder has started; a lower one needs an explicit rollback from the window.

use std::cmp::Ordering;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use crate::{Error, Result};

/// A SemVer 2.0 version: `MAJOR.MINOR.PATCH[-PRERELEASE]`. Build metadata (`+…`) is refused rather
/// than ignored, so two different strings never compare equal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<Ident>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Alpha(String),
}

fn number(s: &str, whole: &str) -> Result<u64> {
    let bad = || Error::BadVersion(whole.to_string());
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return Err(bad());
    }
    s.parse().map_err(|_| bad())
}

impl Version {
    pub fn parse(s: &str) -> Result<Version> {
        let bad = || Error::BadVersion(s.to_string());
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut parts = core.split('.');
        let (Some(a), Some(b), Some(c), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(bad());
        };
        let pre = match pre {
            None => Vec::new(),
            Some(p) => p
                .split('.')
                .map(|id| {
                    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    {
                        Err(bad())
                    } else if id.bytes().all(|b| b.is_ascii_digit()) {
                        number(id, s).map(Ident::Num)
                    } else {
                        Ok(Ident::Alpha(id.to_string()))
                    }
                })
                .collect::<Result<_>>()?,
        };
        Ok(Version {
            major: number(a, s)?,
            minor: number(b, s)?,
            patch: number(c, s)?,
            pre,
        })
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // A release is newer than any of its prereleases.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let o = match (a, b) {
                            (Ident::Num(x), Ident::Num(y)) => x.cmp(y),
                            (Ident::Num(_), Ident::Alpha(_)) => Ordering::Less,
                            (Ident::Alpha(_), Ident::Num(_)) => Ordering::Greater,
                            (Ident::Alpha(x), Ident::Alpha(y)) => x.cmp(y),
                        };
                        if o != Ordering::Equal {
                            return o;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Whether a lower version than the floor may start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rollback {
    Refuse,
    /// The window asked for this version on purpose.
    Allow,
}

/// Refuse `candidate` if it is lower than `highest_seen`, unless rolling back on purpose.
pub fn check_not_downgrade(
    candidate: &str,
    highest_seen: Option<&str>,
    rollback: Rollback,
) -> Result<()> {
    let c = Version::parse(candidate)?;
    let Some(h) = highest_seen else { return Ok(()) };
    if c < Version::parse(h)? && rollback == Rollback::Refuse {
        return Err(Error::Downgrade {
            candidate: candidate.to_string(),
            highest: h.to_string(),
        });
    }
    Ok(())
}

/// The floor stored at `path`, or `None` when nothing has started yet.
pub fn read_highest_seen(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => {
            let v = s.trim().to_string();
            Version::parse(&v)?;
            Ok(Some(v))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Error::io(format!("read {}", path.display()), e)),
    }
}

/// Record that `version` started. The floor only rises, except on an explicit rollback, which sets
/// it to the version rolled back to: otherwise the next start after a reboot would refuse the
/// version the person chose. Written to a temporary file and renamed, so a crash leaves the old
/// floor or the new one, never half of one.
pub fn record_started(path: &Path, version: &str, rollback: Rollback) -> Result<()> {
    let v = Version::parse(version)?;
    if rollback == Rollback::Refuse {
        if let Some(h) = read_highest_seen(path)? {
            if Version::parse(&h)? >= v {
                return Ok(());
            }
        }
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let write = || -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(format!("{version}\n").as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        Error::io(format!("write {}", path.display()), e)
    })
}
