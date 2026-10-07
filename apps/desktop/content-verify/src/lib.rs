//! Verifies Centralu's signed content and copies it where it can be run (docs/plans/thin-shell.md §4).
//!
//! The shell (and, on an update, the keeper) runs code from outside any signed app bundle with the
//! person's permissions. The reason to trust that code is a manifest the release workflow signed with
//! a key only the release environment holds. This crate checks that signature against the public keys
//! built into it, then copies **only the files the manifest lists**, hashing the bytes it copies from
//! the same open descriptor, into a fresh folder that is renamed into place only once every file
//! matched. What runs is the copy, never the source.
//!
//! # Formats
//!
//! Written by `scripts/content-manifest.mts` and described in docs/plans/thin-shell.md §4; change
//! the three together.
//!
//! * `content-manifest.json`: `{ "format": 1, "appVersion", "platform", "minShellVersion",
//!   "files": [{ "path", "size", "sha256", "executable" }] }`. `platform` is
//!   `<process.platform>-<process.arch>` as Node names it (`darwin-arm64`). `sha256` is 64
//!   lowercase hex characters. Unknown fields are ignored; a change an older verifier must not
//!   ignore bumps `format`, which every older verifier refuses.
//! * `content-manifest.json.sig`: `{ "format": 1, "algorithm": "ed25519", "keyId", "signature",
//!   "comment" }`. `signature` is the base64 of a 64-byte ed25519 signature over the manifest
//!   file's exact bytes. `comment` is for people.
//! * Key id: the first 8 bytes of SHA-256 over the raw 32-byte public key, 16 lowercase hex
//!   characters. It selects the key to check with; trust comes from the key being built in.
//!
//! # Paths
//!
//! A listed path is relative and `/`-separated, with no empty, `.` or `..` component, no `\` and no
//! control character, and is not the manifest or its signature. Two paths that differ only in ASCII
//! case are refused as duplicates (one file on a default APFS volume). In the source, no component of
//! a listed path may be a symlink, and the file itself must be a regular file.

mod error;
mod keys;
mod manifest;
pub mod version;

#[cfg(unix)]
mod copy;

pub use error::Error;
pub use keys::{embedded_keys, key_id, TrustedKey};
pub use manifest::{
    current_platform, verify_manifest, Expect, FileEntry, Manifest, MANIFEST_FORMAT,
};

#[cfg(unix)]
pub use copy::{remove_content, verify_and_copy};

/// The manifest's file name, at the top of a content folder.
pub const MANIFEST_NAME: &str = "content-manifest.json";
/// The detached signature's file name, beside the manifest.
pub const SIGNATURE_NAME: &str = "content-manifest.json.sig";

/// Upper bound on the manifest file. The host lists 81 files in 17 KiB (0.1.0-beta.11); a
/// manifest larger than this is not one the release wrote, and is not read into memory.
pub const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
/// Upper bound on the signature file (a real one is under 400 bytes).
pub const MAX_SIGNATURE_BYTES: u64 = 64 * 1024;

pub type Result<T> = std::result::Result<T, Error>;
