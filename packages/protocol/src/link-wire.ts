// The sizes of the values a hub and a linked machine exchange to pair by key (docs/plans/key-pairing.md §4.3): the
// frame schemas here take their shapes from them, and agent-host's `link-keys.ts` decodes strictly to them.

export const LINK_NONCE_BYTES = 24
/** Ed25519 */
export const LINK_PUBLIC_KEY_BYTES = 32
/** Ed25519 */
export const LINK_SIGNATURE_BYTES = 64

/** Without padding */
export function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3)
}

/** Length and alphabet only; the strict decoding stays the receiver's */
export function base64urlShape(bytes: number): RegExp {
  return new RegExp(`^[A-Za-z0-9_-]{${base64urlLength(bytes)}}$`)
}
