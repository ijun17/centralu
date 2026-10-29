/**
 * The sizes of the values a hub and a linked machine exchange to pair by key (#1711, docs/plans/key-pairing.md §4.3,
 * "The bytes"), defined once: the frame schemas here take their shapes from them, and agent-host's `link-keys.ts` decodes
 * strictly to them.
 */

/** A nonce: 24 random bytes */
export const LINK_NONCE_BYTES = 24
/** An Ed25519 public key */
export const LINK_PUBLIC_KEY_BYTES = 32
/** An Ed25519 signature */
export const LINK_SIGNATURE_BYTES = 64

/** The characters of `bytes` bytes as base64url without padding: 24 give 32, 32 give 43, 64 give 86 */
export function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3)
}

/** The shape of `bytes` bytes as base64url: the exact length and the alphabet. The strict decoding stays the receiver's */
export function base64urlShape(bytes: number): RegExp {
  return new RegExp(`^[A-Za-z0-9_-]{${base64urlLength(bytes)}}$`)
}
