//! The limited credential (#1405): what `keeper.sock` hands a process that is not a window.
//!
//! The front door's token is the window's: with it a client calls every method of the host, and
//! the window shows its own confirmations first. Every other process of this user (an agent, a
//! script an agent wrote, a tool, `pnpm dev:live`) gets this instead. With it the host runs the
//! everyday methods and holds what cannot be undone for the person's card
//! (`packages/agent-host/src/transport/limited-token.ts` and `method-rights.ts`).
//!
//! **Derived, not stored**, as the host derives it: `ccl1:` and the HMAC-SHA256 of the label
//! `centralu limited token v1` keyed by the token, base64url without padding. Every host behind
//! the door derives the same from the token it was handed, so nothing is handed over in a swap or
//! a keeper handoff, and holding it gives nothing toward the token. `limited_token_matches_the_host`
//! below pins the same vector as the host's `limited-token.test.ts`.

use sha2::{Digest, Sha256};

const PREFIX: &str = "ccl1";
const LABEL: &[u8] = b"centralu limited token v1";

/// The limited credential that goes with the front door's `token`.
pub fn limited_token(token: &str) -> String {
    format!("{PREFIX}:{}", base64url(&hmac_sha256(token.as_bytes(), LABEL)))
}

/// HMAC-SHA256 (RFC 2104) over `sha2`, which the keeper already links: a key longer than the
/// block is hashed first, a shorter one padded with zeros.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// Base64url without padding (RFC 4648 §5), as Node's `digest('base64url')` writes it.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limited_token_matches_the_host() {
        // The same vectors as packages/agent-host/src/transport/limited-token.test.ts
        assert_eq!(limited_token("0123456789abcdef0123456789abcdef"), "ccl1:GCq4ylEN4gVq4i5lDTQIGSQHYNP_K-4C2FBfWGM0JAc");
        assert_eq!(limited_token("test-token"), "ccl1:bRS_kvn-WzK4GDYf6ToAgbG5AzPQaLMW5Y7NtD5nhdM");
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // RFC 4231 test case 2: key "Jefe"
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(content_verify::hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block is hashed first
        let mac = hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(content_verify::hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn base64url_has_no_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn the_limited_token_is_not_the_token() {
        let token = "0123456789abcdef0123456789abcdef";
        assert!(!limited_token(token).contains(token));
    }
}
