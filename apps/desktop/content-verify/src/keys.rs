use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::VerifyingKey;
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// The public keys this build trusts, compiled in. Never read at run time: whoever can change the
/// content could change a key file beside it too (thin-shell.md §4).
const KEYS_JSON: &str = include_str!("../../../../packaging/shell/keys.json");

/// A public key content may be signed with.
#[derive(Clone, Debug)]
pub struct TrustedKey {
    /// `current` or `next` for the built-in keys; free text for keys a test makes.
    pub name: String,
    pub id: String,
    pub(crate) key: VerifyingKey,
}

impl TrustedKey {
    /// A key from its raw 32 bytes. Refuses bytes that are not a curve point and small-order
    /// (weak) keys, under which a signature can verify for more than one message.
    pub fn from_raw(name: impl Into<String>, raw: &[u8]) -> Result<TrustedKey> {
        let bytes: [u8; 32] = raw.try_into().map_err(|_| {
            Error::SignatureMalformed(format!("a public key is 32 bytes, not {}", raw.len()))
        })?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| Error::SignatureMalformed("a public key is not a curve point".into()))?;
        if key.is_weak() {
            return Err(Error::SignatureMalformed(
                "a public key is a weak key".into(),
            ));
        }
        Ok(TrustedKey {
            name: name.into(),
            id: key_id(&bytes),
            key,
        })
    }

    pub fn raw(&self) -> [u8; 32] {
        self.key.to_bytes()
    }
}

/// First 8 bytes of SHA-256 over the raw public key, lowercase hex.
pub fn key_id(raw: &[u8; 32]) -> String {
    Sha256::digest(raw)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `current` and `next` from `packaging/shell/keys.json`, as built into this binary.
pub fn embedded_keys() -> Result<Vec<TrustedKey>> {
    let json: serde_json::Value = serde_json::from_str(KEYS_JSON)
        .map_err(|e| Error::SignatureMalformed(format!("built-in keys.json: {e}")))?;
    ["current", "next"]
        .iter()
        .map(|name| {
            let b64 = json[name].as_str().ok_or_else(|| {
                Error::SignatureMalformed(format!("built-in keys.json has no {name}"))
            })?;
            let raw = STANDARD.decode(b64).map_err(|_| {
                Error::SignatureMalformed(format!("built-in key {name} is not base64"))
            })?;
            TrustedKey::from_raw(*name, &raw)
        })
        .collect()
}
