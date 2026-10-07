use std::collections::HashSet;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::Signature;
use serde::Deserialize;

use crate::version::Version;
use crate::{Error, Result, TrustedKey, MANIFEST_NAME, SIGNATURE_NAME};

/// The only manifest and signature format this verifier reads.
pub const MANIFEST_FORMAT: u64 = 1;

/// What the caller requires of the content besides a valid signature.
#[derive(Clone, Debug)]
pub struct Expect {
    /// `darwin-arm64` and so on; [`current_platform`] for the running build.
    pub platform: String,
    /// The asking shell's version, checked against `minShellVersion`. `None` for a caller that is
    /// not a shell (the keeper on a handoff): the window decides about the shell.
    pub shell_version: Option<u64>,
}

/// A verified manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub app_version: String,
    pub platform: String,
    pub min_shell_version: u64,
    pub files: Vec<FileEntry>,
    /// Id of the key that signed it.
    pub key_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub sha256: [u8; 32],
    pub executable: bool,
}

#[derive(Deserialize)]
struct FormatOnly {
    format: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureFile {
    format: u64,
    algorithm: String,
    key_id: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    app_version: String,
    platform: String,
    min_shell_version: u64,
    files: Vec<RawFile>,
}

#[derive(Deserialize)]
struct RawFile {
    path: String,
    size: u64,
    sha256: String,
    executable: bool,
}

/// The platform name the release uses for this build (Node's `process.platform-process.arch`).
pub fn current_platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("{os}-{arch}")
}

/// Check `signature` over the exact bytes of `manifest` against `keys`, then parse the manifest and
/// check everything about it that does not need the files. Nothing in the manifest is parsed before
/// its signature has verified.
pub fn verify_manifest(
    manifest: &[u8],
    signature: &[u8],
    keys: &[TrustedKey],
    expect: &Expect,
) -> Result<Manifest> {
    let sig: SignatureFile =
        serde_json::from_slice(signature).map_err(|e| Error::SignatureMalformed(e.to_string()))?;
    if sig.format != MANIFEST_FORMAT {
        return Err(Error::UnsupportedFormat(sig.format));
    }
    if sig.algorithm != "ed25519" {
        return Err(Error::SignatureMalformed(format!(
            "algorithm {:?}",
            sig.algorithm
        )));
    }
    let key = keys
        .iter()
        .find(|k| k.id == sig.key_id)
        .ok_or_else(|| Error::UnknownKey(sig.key_id.clone()))?;
    let raw = STANDARD
        .decode(&sig.signature)
        .map_err(|_| Error::SignatureMalformed("signature is not base64".into()))?;
    let raw: [u8; 64] = raw.as_slice().try_into().map_err(|_| {
        Error::SignatureMalformed(format!("signature is {} bytes, not 64", raw.len()))
    })?;
    key.key
        .verify_strict(manifest, &Signature::from_bytes(&raw))
        .map_err(|_| Error::BadSignature)?;

    // Signed by a trusted key from here on, so a failure below is a release bug, not an attack;
    // it is still a refusal.
    let format: FormatOnly =
        serde_json::from_slice(manifest).map_err(|e| Error::ManifestMalformed(e.to_string()))?;
    if format.format != MANIFEST_FORMAT {
        return Err(Error::UnsupportedFormat(format.format));
    }
    let m: RawManifest =
        serde_json::from_slice(manifest).map_err(|e| Error::ManifestMalformed(e.to_string()))?;
    if m.platform != expect.platform {
        return Err(Error::WrongPlatform {
            expected: expect.platform.clone(),
            found: m.platform,
        });
    }
    if let Some(have) = expect.shell_version {
        if m.min_shell_version > have {
            return Err(Error::ShellTooOld {
                needed: m.min_shell_version,
                have,
            });
        }
    }
    Version::parse(&m.app_version)?;

    let mut folded = HashSet::new();
    let mut files = Vec::with_capacity(m.files.len());
    for f in m.files {
        check_path(&f.path)?;
        if !folded.insert(f.path.to_ascii_lowercase()) {
            return Err(Error::DuplicatePath(f.path));
        }
        files.push(FileEntry {
            sha256: parse_sha256(&f.path, &f.sha256)?,
            path: f.path,
            size: f.size,
            executable: f.executable,
        });
    }
    // A path that is also the folder of another ("a" and "a/b") cannot be both.
    for f in &files {
        let lower = f.path.to_ascii_lowercase();
        let mut prefix = lower.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            if folded.contains(parent) {
                return Err(Error::BadPath {
                    path: f.path.clone(),
                    reason: "is inside another listed file",
                });
            }
            prefix = parent;
        }
    }
    Ok(Manifest {
        app_version: m.app_version,
        platform: m.platform,
        min_shell_version: m.min_shell_version,
        files,
        key_id: sig.key_id,
    })
}

/// The rules in the crate docs. The same as `pathProblem` in scripts/content-manifest.mts.
pub(crate) fn check_path(path: &str) -> Result<()> {
    let bad = |reason| {
        Err(Error::BadPath {
            path: path.to_string(),
            reason,
        })
    };
    if path.is_empty() {
        return bad("is empty");
    }
    if path.starts_with('/') {
        return bad("is absolute");
    }
    if path.contains('\\') {
        return bad("contains a backslash");
    }
    if path.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return bad("contains a control character");
    }
    for part in path.split('/') {
        if part.is_empty() {
            return bad("has an empty component");
        }
        if part == "." || part == ".." {
            return bad("has a . or .. component");
        }
    }
    if path == MANIFEST_NAME || path == SIGNATURE_NAME {
        return bad("is the manifest or its signature");
    }
    Ok(())
}

fn parse_sha256(path: &str, hex: &str) -> Result<[u8; 32]> {
    let bad = || {
        Error::ManifestMalformed(format!(
            "sha256 of {path:?} is not 64 lowercase hex characters"
        ))
    };
    if hex.len() != 64 {
        return Err(bad());
    }
    let mut out = [0u8; 32];
    for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
        let nib = |c: u8| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        };
        out[i] = (nib(pair[0]).ok_or_else(bad)? << 4) | nib(pair[1]).ok_or_else(bad)?;
    }
    Ok(out)
}
