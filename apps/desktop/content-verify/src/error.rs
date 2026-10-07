use std::fmt;
use std::io;
use std::path::PathBuf;

/// Why content was refused. Every variant is a refusal: nothing was put in place.
#[derive(Debug)]
pub enum Error {
    /// The manifest or the signature file is absent from the content folder.
    Missing(&'static str),
    /// The manifest or the signature file is a symlink, not a regular file, or too large.
    BadFile {
        name: &'static str,
        reason: &'static str,
    },
    ManifestMalformed(String),
    SignatureMalformed(String),
    /// `format` (of the manifest or the signature file) is not one this verifier knows.
    UnsupportedFormat(u64),
    /// Signed with a key that is not built in, which includes every throwaway key.
    UnknownKey(String),
    /// The key is built in and the signature does not verify over these bytes.
    BadSignature,
    WrongPlatform {
        expected: String,
        found: String,
    },
    /// The content needs a newer shell than the one asking.
    ShellTooOld {
        needed: u64,
        have: u64,
    },
    BadPath {
        path: String,
        reason: &'static str,
    },
    DuplicatePath(String),
    /// A component of a listed path is a symlink in the source.
    Symlink(String),
    /// A listed path is a directory, a FIFO, a device or a socket in the source.
    NotRegularFile(String),
    SizeMismatch {
        path: String,
        expected: u64,
        found: u64,
    },
    HashMismatch(String),
    /// The copy, read back, is not what was written. Something changed it underneath us.
    CopyMismatch(String),
    DestinationExists(PathBuf),
    BadVersion(String),
    /// A lower version than the highest one started, without an explicit rollback.
    Downgrade {
        candidate: String,
        highest: String,
    },
    Io {
        context: String,
        source: io::Error,
    },
}

impl Error {
    pub(crate) fn io(context: impl Into<String>, source: io::Error) -> Error {
        Error::Io {
            context: context.into(),
            source,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Missing(name) => write!(f, "{name} is missing"),
            Error::BadFile { name, reason } => write!(f, "{name} {reason}"),
            Error::ManifestMalformed(why) => write!(f, "the manifest is malformed: {why}"),
            Error::SignatureMalformed(why) => write!(f, "the signature file is malformed: {why}"),
            Error::UnsupportedFormat(n) => {
                write!(f, "format {n} is not supported by this verifier")
            }
            Error::UnknownKey(id) => write!(f, "signed with an unknown key {id}"),
            Error::BadSignature => write!(f, "the signature does not match the manifest"),
            Error::WrongPlatform { expected, found } => {
                write!(f, "the content is for {found}, this is {expected}")
            }
            Error::ShellTooOld { needed, have } => {
                write!(f, "the content needs shell {needed}, this is shell {have}")
            }
            Error::BadPath { path, reason } => write!(f, "listed path {path:?} {reason}"),
            Error::DuplicatePath(path) => write!(f, "{path:?} is listed twice"),
            Error::Symlink(path) => write!(f, "{path:?} goes through a symlink"),
            Error::NotRegularFile(path) => write!(f, "{path:?} is not a regular file"),
            Error::SizeMismatch {
                path,
                expected,
                found,
            } => {
                write!(f, "{path:?} is {found} bytes, the manifest says {expected}")
            }
            Error::HashMismatch(path) => write!(f, "{path:?} does not match its hash"),
            Error::CopyMismatch(path) => {
                write!(f, "the copy of {path:?} changed after it was written")
            }
            Error::DestinationExists(path) => write!(f, "{} already exists", path.display()),
            Error::BadVersion(v) => write!(f, "{v:?} is not a version"),
            Error::Downgrade { candidate, highest } => {
                write!(
                    f,
                    "{candidate} is older than {highest}, which has already run"
                )
            }
            Error::Io { context, source } => write!(f, "{context}: {source}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}
