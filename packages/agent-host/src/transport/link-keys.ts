import { createHmac, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES } from '@cc/protocol'
import { CREDENTIAL_ID_RE } from '../lifecycle/serve-credentials.js'

/**
 * The keys and the signed transcript of a hub's key pairing with a linked machine (#1711, docs/plans/key-pairing.md
 * §4.1 and §4.3). Pure: nothing here reads a file or a socket, and nothing on a live path calls it yet (slice 2).
 *
 * Both sides sign one transcript `T` before hello, each under its own role label, so a signature seen once opens
 * nothing elsewhere: the host's nonce makes a hub signature good for one socket, the hub's nonce makes a host signature
 * good for one dial, the two public keys tie it to one machine and one hub, and the loopback address the hub forwards
 * to rules out a relay to a host listening anywhere else.
 *
 * Every value that crosses the link is decoded strictly (`decodeBase64url`), and every public key goes through
 * `parseLinkPublicKey` wherever it is read: `node:crypto` verifies a forged signature under a small-order key.
 */

/** The `token` a key hello carries (§4.3 step 4): fixed and not secret. Its spaces keep it apart from every drawn or derived credential */
export const LINK_AUTH_MARKER = 'centralu link auth v1'

const CONTEXT_LABEL = 'centralu link v1'
const ROLE_LABEL = { hub: 'centralu link hub v1', host: 'centralu link host v1' } as const
const HOST_KEY_LABEL = 'centralu host key v1'

/** Who signs: the two signatures over one transcript carry different labels, so one is never taken for the other */
export type LinkRole = keyof typeof ROLE_LABEL

/**
 * The bytes of `text`, read as base64url without padding, when it is exactly the encoding of `bytes` bytes: the exact
 * length, only `[A-Za-z0-9_-]`, and encoding the bytes again gives the same string. Node's own decoding skips other
 * characters and ignores the last character's spare bits, so without the round trip several strings name one value.
 * The round trip is the whole check: Node's encoding of `bytes` bytes has exactly that length and only that alphabet,
 * so a string that equals it has both (a separate length or alphabet test would refuse nothing more, measured).
 */
export function decodeBase64url(text: unknown, bytes: number): Buffer | null {
  if (typeof text !== 'string') return null
  const raw = Buffer.from(text, 'base64url')
  if (raw.length !== bytes || raw.toString('base64url') !== text) return null
  return raw
}

const P = 2n ** 255n - 19n

/**
 * The y-coordinates of the eight small-order points of Ed25519 (orders 1, 2, 4 and 8), as libsodium's
 * `ge25519_has_small_order` lists their encodings: 0, 1, p − 1 and the two y of the points of order 8. The test derives
 * the last two from the curve equation and checks them against these.
 */
const SMALL_ORDER_Y: readonly bigint[] = [
  0n,
  1n,
  P - 1n,
  yOf(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex')),
  yOf(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex')),
]

/** The 32 bytes as a little-endian number with the top bit (the sign of x) cleared: the point's y as encoded */
function yOf(raw: Uint8Array): bigint {
  let y = 0n
  for (let i = raw.length - 1; i >= 0; i--) {
    const b = raw[i] ?? 0
    y = (y << 8n) | BigInt(i === raw.length - 1 ? b & 0x7f : b)
  }
  return y
}

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/**
 * A public key that passed `parseLinkPublicKey`: only such a key is verified against (`verifyLink`, which checks it with
 * `LinkPublicKey.is` at run time as well as by type). A class with a private constructor and a private field, so no
 * object literal and no other module can make one.
 */
export class LinkPublicKey {
  readonly #checked = true
  private constructor(
    /** As on the wire and in `serve.json`: 43 characters of base64url */
    readonly text: string,
    /** The 32 bytes, as they enter the transcript */
    readonly raw: Buffer,
    readonly key: KeyObject,
  ) {}

  /** `parseLinkPublicKey`'s checks; see there */
  static parse(text: unknown): LinkPublicKey | null {
    if (typeof text !== 'string') return null
    const raw = decodeBase64url(text, LINK_PUBLIC_KEY_BYTES)
    if (!raw) return null
    const y = yOf(raw)
    if (y >= P) return null
    if (SMALL_ORDER_Y.includes(y)) return null
    let key: KeyObject
    try {
      key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
    } catch {
      return null
    }
    if (key.asymmetricKeyType !== 'ed25519') return null
    return new LinkPublicKey(text, raw, key)
  }

  /** Whether `value` is a key that came through `parse`: a real check at run time, which a cast to the type does not pass */
  static is(value: unknown): value is LinkPublicKey {
    return typeof value === 'object' && value !== null && #checked in value
  }
}

/**
 * The public key `text` names, or null when it is refused (§4.1): not exactly 43 canonical base64url characters for 32
 * bytes, a y that is not below p (a non-canonical encoding, which includes those of p and p + 1), the y of a
 * small-order point with either sign bit, or bytes `node:crypto` does not take as an Ed25519 key. A check of the
 * decoded point, not a test signature: under a key of order 8 a forged signature verifies for only some messages.
 */
export function parseLinkPublicKey(text: unknown): LinkPublicKey | null {
  return LinkPublicKey.parse(text)
}

/** The raw public key of an Ed25519 key (private or public), checked as any other (`parseLinkPublicKey`) */
export function linkPublicKeyOf(key: KeyObject): LinkPublicKey | null {
  const pub = key.type === 'private' ? createPublicKey(key) : key
  if (pub.asymmetricKeyType !== 'ed25519') return null
  const der = pub.export({ format: 'der', type: 'spki' })
  return parseLinkPublicKey(der.subarray(SPKI_PREFIX.length).toString('base64url'))
}

/** The Ed25519 private key of a 32-byte seed, wrapped as PKCS#8 */
export function linkPrivateKeyOfSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes')
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
}

/**
 * The machine's host key (§4.1): derived from the `key` the host was started with, so it needs no new secret and is the
 * same across host swaps. `seed = HMAC-SHA256(key, "centralu host key v1")`, keyed by the key's string as the other
 * values derived from it are (`limitedToken`, `hostProof`).
 */
export function hostLinkKey(hostKey: string): { privateKey: KeyObject; publicKey: LinkPublicKey } {
  // An empty key is no key: deriving from it would give a stable, guessable one. The caller passes a key it has already checked
  if (typeof hostKey !== 'string' || hostKey.length === 0) throw new Error('The host key is empty')
  const privateKey = linkPrivateKeyOfSeed(createHmac('sha256', hostKey).update(HOST_KEY_LABEL).digest())
  const publicKey = linkPublicKeyOf(privateKey)
  // A seed whose public key is refused would need SHA-512 to land on one of five values: not met, but never signed with
  if (!publicKey) throw new Error('The derived host key was refused')
  return { privateKey, publicKey }
}

const MAX_PORT = 65535
const ADDRESS_PREFIX = '127.0.0.1:'
const DOOR_PREFIX = 'ws://'

/** The transcript's address for a loopback port: `127.0.0.1:<port>`, decimal with no leading zero, 1 to 65535; null for any other port. The one place the form is written */
export function linkAddress(port: unknown): string | null {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > MAX_PORT) return null
  return `${ADDRESS_PREFIX}${port}`
}

/**
 * `text` when it is exactly an address `linkAddress` makes, else null: the port is read and the address built again, and
 * only the same string passes, so the form is `linkAddress`'s alone (a leading zero, a sign, a space, an exponent, a
 * port out of range or a trailing character each build another string)
 */
export function readLinkAddress(text: unknown): string | null {
  if (typeof text !== 'string' || !text.startsWith(ADDRESS_PREFIX)) return null
  return linkAddress(Number(text.slice(ADDRESS_PREFIX.length))) === text ? text : null
}

/**
 * The address a host without a keeper signs (§4.3): the accepted socket's local address and port. An IPv4-mapped
 * `::ffff:127.0.0.1` is read as `127.0.0.1`; any other local address gives none, so the socket cannot be full by key.
 */
export function linkAddressOfSocket(localAddress: string | undefined, localPort: number | undefined): string | null {
  if (localAddress !== '127.0.0.1' && localAddress !== '::ffff:127.0.0.1') return null
  return linkAddress(localPort)
}

/**
 * The address a host under a keeper signs (§4.3): the front door's, from `CC_FRONT_DOOR`, which must be exactly
 * `ws://127.0.0.1:<port>`. The host's socket then comes from the door's relay, and its local port is the inner one.
 * Read as written, not through `URL`, which would turn `08080` into `8080`.
 */
export function linkAddressOfDoor(frontDoor: string | undefined): string | null {
  return frontDoor?.startsWith(DOOR_PREFIX) ? readLinkAddress(frontDoor.slice(DOOR_PREFIX.length)) : null
}

/**
 * `field(b) = u32be(len(b)) ‖ b` for each part, concatenated: no two different lists of parts give the same bytes. A
 * string is taken as ASCII and throws on a character above 0x7f, which a one-byte-per-character encoding would fold
 * onto another (U+0100 onto NUL); every string the transcript holds is checked before it gets here
 */
export function encodeFields(parts: readonly (Uint8Array | string)[]): Buffer {
  const out: Buffer[] = []
  for (const part of parts) {
    if (typeof part === 'string' && Array.from(part).some((c) => (c.codePointAt(0) ?? 0) > 0x7f)) throw new Error('A field string is ASCII')
    const b = typeof part === 'string' ? Buffer.from(part, 'ascii') : Buffer.from(part)
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length)
    out.push(len, b)
  }
  return Buffer.concat(out)
}

/** What the transcript is built from, each as on the wire (§4.3, "Where each side takes each value") */
export type LinkTranscriptInput = {
  /** `Nh`: the hub's nonce for this dial, 32 characters */
  hubNonce: string
  /** `Ns`: the host's nonce for this socket, 32 characters */
  hostNonce: string
  /** `Pm`: the host's public key */
  hostKey: string
  /** `Ph`: the hub's public key */
  hubKey: string
  /** The hub's key entry in `serve.json`, 8 lowercase hex characters */
  keyId: string
  /** `127.0.0.1:<port>`, from `linkAddress`, `linkAddressOfSocket` or `linkAddressOfDoor` */
  address: string
}

/**
 * The transcript `T` (§4.3): `field("centralu link v1") ‖ field(Nh) ‖ field(Ns) ‖ field(Pm) ‖ field(Ph) ‖ field(keyId)
 * ‖ field(addr)`, the nonces and keys as their raw bytes. Null when any value is refused: a nonce or key not decoded
 * strictly, a key refused by `parseLinkPublicKey`, an id not of the entry shape, or an address not of the one form.
 */
export function linkTranscript(input: LinkTranscriptInput): Buffer | null {
  const hubNonce = decodeBase64url(input.hubNonce, LINK_NONCE_BYTES)
  const hostNonce = decodeBase64url(input.hostNonce, LINK_NONCE_BYTES)
  const hostKey = parseLinkPublicKey(input.hostKey)
  const hubKey = parseLinkPublicKey(input.hubKey)
  if (!hubNonce || !hostNonce || !hostKey || !hubKey) return null
  if (typeof input.keyId !== 'string' || !CREDENTIAL_ID_RE.test(input.keyId)) return null
  const address = readLinkAddress(input.address)
  if (!address) return null
  return encodeFields([CONTEXT_LABEL, hubNonce, hostNonce, hostKey.raw, hubKey.raw, input.keyId, address])
}

/** What `role` signs: `field(role label) ‖ T` */
function signedBytes(role: LinkRole, transcript: Uint8Array): Buffer {
  return Buffer.concat([encodeFields([ROLE_LABEL[role]]), transcript])
}

/** `role`'s signature over `transcript`, base64url (86 characters) */
export function signLink(role: LinkRole, privateKey: KeyObject, transcript: Uint8Array): string {
  return sign(null, signedBytes(role, transcript), privateKey).toString('base64url')
}

/** Whether `sig` is `role`'s signature over `transcript` under `publicKey`; a signature not decoded strictly, or a key that did not come through `parseLinkPublicKey`, is refused */
export function verifyLink(role: LinkRole, publicKey: LinkPublicKey, transcript: Uint8Array, sig: unknown): boolean {
  if (!LinkPublicKey.is(publicKey)) return false
  const raw = decodeBase64url(sig, LINK_SIGNATURE_BYTES)
  if (!raw) return false
  try {
    return verify(null, signedBytes(role, transcript), publicKey.key, raw)
  } catch {
    return false
  }
}
