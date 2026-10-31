/**
 * The launcher's side of a hub's key pairing (#1711, docs/plans/key-pairing.md §4.1 to §4.3): the check of a hub's
 * public key at `--pair-key`, the public key of the host's signing key derived from serve.json's `key`, and the check of
 * the running host's signed proof. The same rules as the host's `transport/link-keys.ts`, which this standalone launcher
 * cannot import; `tooling/launcher-keys.test.ts` holds the two to the same answers and to the pinned vector.
 */
import { createHmac, createPrivateKey, createPublicKey, verify } from 'node:crypto'

/** Bytes of a nonce, a public key and a signature (`@cc/protocol` `link-wire.ts`) */
export const LINK_NONCE_BYTES = 24
export const LINK_PUBLIC_KEY_BYTES = 32
export const LINK_SIGNATURE_BYTES = 64

const CONTEXT_LABEL = 'centralu link v1'
const HOST_ROLE_LABEL = 'centralu link host v1'
const HOST_KEY_LABEL = 'centralu host key v1'
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const P = 2n ** 255n - 19n

/** The bytes of `text` when it is exactly the base64url (no padding) of `bytes` bytes: encoding them again gives the same string */
export function decodeBase64url(text, bytes) {
  if (typeof text !== 'string') return null
  const raw = Buffer.from(text, 'base64url')
  if (raw.length !== bytes || raw.toString('base64url') !== text) return null
  return raw
}

/** The 32 bytes as a little-endian number with the top bit (the sign of x) cleared */
function yOf(raw) {
  let y = 0n
  for (let i = raw.length - 1; i >= 0; i--) y = (y << 8n) | BigInt(i === raw.length - 1 ? raw[i] & 0x7f : raw[i])
  return y
}

/** The y of the eight small-order points: 0, 1, p − 1 and the two of order 8 (libsodium's `ge25519_has_small_order`) */
const SMALL_ORDER_Y = [
  0n,
  1n,
  P - 1n,
  yOf(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex')),
  yOf(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex')),
]

/**
 * `{ text, raw, key }` for a public key the host takes (§4.1), or null: exactly 43 canonical base64url characters, a y
 * below p, not the y of a small-order point (either sign bit), and an Ed25519 key `node:crypto` imports. Unchecked, on
 * Node 22 a small-order key verifies a forged signature over every message.
 */
export function parseLinkPublicKey(text) {
  const raw = decodeBase64url(text, LINK_PUBLIC_KEY_BYTES)
  if (!raw) return null
  const y = yOf(raw)
  if (y >= P || SMALL_ORDER_Y.includes(y)) return null
  let key
  try {
    key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  } catch {
    return null
  }
  return key.asymmetricKeyType === 'ed25519' ? { text, raw, key } : null
}

/**
 * The public key a host started with `key` signs with (§4.1): `seed = HMAC-SHA256(key, "centralu host key v1")`, as
 * PKCS#8. What `--pair-key` reports when no host runs and none of a keeper's may run with another key (§4.2).
 */
export function hostLinkPublicKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('The host key is empty')
  const seed = createHmac('sha256', key).update(HOST_KEY_LABEL).digest()
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' })
  const text = der.subarray(SPKI_PREFIX.length).toString('base64url')
  if (!parseLinkPublicKey(text)) throw new Error('The derived host key was refused')
  return text
}

/** `u32be(len) ‖ bytes` for each part; a string as ASCII, and one with another character throws */
export function encodeFields(parts) {
  const out = []
  for (const part of parts) {
    if (typeof part === 'string' && Array.from(part).some((c) => c.codePointAt(0) > 0x7f)) throw new Error('A field string is ASCII')
    const b = typeof part === 'string' ? Buffer.from(part, 'ascii') : Buffer.from(part)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    out.push(len, b)
  }
  return Buffer.concat(out)
}

/** `127.0.0.1:<port>` for a port 1 to 65535, null otherwise (the host's `linkAddress`) */
export function linkAddress(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? `127.0.0.1:${port}` : null
}

/** The transcript `T` (§4.3), or null when a value is refused */
export function linkTranscript({ hubNonce, hostNonce, hostKey, hubKey, keyId, address }) {
  const nh = decodeBase64url(hubNonce, LINK_NONCE_BYTES)
  const ns = decodeBase64url(hostNonce, LINK_NONCE_BYTES)
  const pm = parseLinkPublicKey(hostKey)
  const ph = parseLinkPublicKey(hubKey)
  if (!nh || !ns || !pm || !ph) return null
  if (typeof keyId !== 'string' || !/^[0-9a-f]{8}$/.test(keyId)) return null
  if (typeof address !== 'string' || !/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(address) || linkAddress(Number(address.slice(10))) !== address) return null
  return encodeFields([CONTEXT_LABEL, nh, ns, pm.raw, ph.raw, keyId, address])
}

/**
 * The key a running host signs with, when `proof` is its signed answer to a key `prove` of `hubNonce` (§4.2 step 3):
 * `hostNonce`, `hostKey` and `sig` all present, strict, and the host's signature verifying over the transcript built
 * here from the hub's key, the entry's id and the address the hub forwards to. Null for anything else: an answer
 * without a signature (a host from before key pairing), or one that does not verify.
 */
export function signedHostKey(proof, { hubNonce, hubKey, keyId, port }) {
  if (proof?.kind !== 'proof' || proof.nonce !== hubNonce) return null
  const pm = parseLinkPublicKey(proof.hostKey)
  const sig = decodeBase64url(proof.sig, LINK_SIGNATURE_BYTES)
  if (!pm || !sig) return null
  const t = linkTranscript({ hubNonce, hostNonce: proof.hostNonce, hostKey: proof.hostKey, hubKey, keyId, address: linkAddress(port) })
  if (!t) return null
  try {
    return verify(null, Buffer.concat([encodeFields([HOST_ROLE_LABEL]), t]), pm.key, sig) ? pm.text : null
  } catch {
    return null
  }
}
