//! The public keys a keeper verifies the next build's content with on a handoff
//! (docs/plans/thin-shell.md §4): `packaging/shell/keys.json`, compiled in through
//! `content_verify::embedded_keys`, the same keys the shell trusts, and nothing else in a build anyone
//! runs.

use content_verify::{embedded_keys, TrustedKey};

// The test key exists only in debug builds made for the integration test. A release build with the
// feature on does not compile, so no release keeper can trust a key outside keys.json by mistake.
#[cfg(all(feature = "test-key", not(debug_assertions)))]
compile_error!(
    "the test-key feature is for debug test builds only: a release keeper trusts packaging/shell/keys.json and nothing else"
);

/// The keys this build verifies content with.
pub fn trusted_keys() -> content_verify::Result<Vec<TrustedKey>> {
    #[allow(unused_mut)]
    let mut keys = embedded_keys()?;
    #[cfg(feature = "test-key")]
    keys.push(test_key()?);
    Ok(keys)
}

/// Whether this build trusts a key beyond keys.json (said in the log, so a test build can never pass
/// for a real one).
pub const TEST_BUILD: bool = cfg!(feature = "test-key");

#[cfg(feature = "test-key")]
fn test_key() -> content_verify::Result<TrustedKey> {
    let raw = base64_lite::decode(env!("CENTRALU_KEEPER_TEST_KEY").trim())
        .ok_or_else(|| content_verify::Error::SignatureMalformed("CENTRALU_KEEPER_TEST_KEY is not base64".into()))?;
    TrustedKey::from_raw("test", &raw)
}

/// Standard base64 for one 44-character key, so the test build needs no crate the release build
/// does not link (the shell's keys.rs does the same).
#[cfg(feature = "test-key")]
mod base64_lite {
    pub fn decode(s: &str) -> Option<Vec<u8>> {
        let val = |c: u8| -> Option<u32> {
            Some(match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => return None,
            } as u32)
        };
        let mut out = Vec::new();
        let mut acc = 0u32;
        let mut bits = 0;
        for &c in s.trim_end_matches('=').as_bytes() {
            acc = (acc << 6) | val(c)?;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
                acc &= (1 << bits) - 1;
            }
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keeper people run trusts exactly the keys in packaging/shell/keys.json, as the shell does.
    #[cfg(not(feature = "test-key"))]
    #[test]
    fn a_build_without_the_test_feature_trusts_exactly_keys_json() {
        let ids = |keys: Vec<TrustedKey>| keys.into_iter().map(|k| (k.name, k.id)).collect::<Vec<_>>();
        let trusted = ids(trusted_keys().unwrap());
        assert_eq!(trusted, ids(embedded_keys().unwrap()));
        assert_eq!(trusted.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["current", "next"]);
        assert!(!TEST_BUILD);
    }
}
