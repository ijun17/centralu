/** The keys and the signed transcript of key pairing (#1711, docs/plans/key-pairing.md §4.1 and §4.3, slice 2) */
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES } from '@cc/protocol'
import {
  LINK_AUTH_MARKER,
  decodeBase64url,
  encodeFields,
  hostLinkKey,
  linkAddress,
  linkAddressOfDoor,
  linkAddressOfSocket,
  linkPrivateKeyOfSeed,
  linkPublicKeyOf,
  linkTranscript,
  parseLinkPublicKey,
  readLinkAddress,
  signLink,
  verifyLink,
  LinkPublicKey,
  type LinkTranscriptInput,
} from './link-keys.js'
import { sameSecret } from './http.js'
import { isLimitedToken, limitedToken } from './limited-token.js'
import { sessionOfToken, sessionToken } from './session-token.js'
import { bridgeSessionOf, bridgeToken } from './bridge-token.js'

/**
 * A small seeded generator, for the property checks below (the repository has no property-testing library): the same
 * cases on every run, so a failure is reproduced by running the test again.
 */
function seeded(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    int: (n: number) => Math.floor(next() * n),
    bytes: (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
  }
}

const P = 2n ** 255n - 19n

/** The 32-byte encoding of a point with this y and sign bit */
function encodePoint(y: bigint, signBit: boolean): Buffer {
  const b = Buffer.alloc(32)
  let v = y
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn)
    v >>= 8n
  }
  if (signBit) b[31]! |= 0x80
  return b
}

function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n
  let b = ((base % P) + P) % P
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return r
}
const inv = (a: bigint) => modPow(a, P - 2n)
const mod = (a: bigint) => ((a % P) + P) % P
/** A square root mod p (p ≡ 5 mod 8), or null */
function sqrt(a: bigint): bigint | null {
  const r = modPow(a, (P + 3n) / 8n)
  if (mod(r * r) === mod(a)) return r
  const i = modPow(2n, (P - 1n) / 4n)
  const r2 = mod(r * i)
  return mod(r2 * r2) === mod(a) ? r2 : null
}

/**
 * The y-coordinates of every small-order point, derived from the curve rather than copied: -x² + y² = 1 + d·x²·y², with
 * d = -121665/121666. Order 1 and 2: (0, ±1). Order 4: y = 0. Order 8: the points P with 2P of order 4, so y(2P) = 0,
 * which by the doubling formula is x² = -y²; on the curve that is d·y⁴ + 2y² - 1 = 0.
 */
function smallOrderYs(): bigint[] {
  const d = mod(-121665n * inv(121666n))
  const disc = sqrt(mod(1n + d))
  if (disc === null) throw new Error('1 + d has no root')
  const ys: bigint[] = [1n, P - 1n, 0n]
  for (const root of [disc, P - disc]) {
    const y2 = mod((P - 1n + root) * inv(d))
    const y = sqrt(y2)
    if (y !== null) ys.push(y, P - y)
  }
  return ys
}

/** Each small-order encoding by name, with both sign bits */
function smallOrderEncodings(): { name: string; raw: Buffer }[] {
  return smallOrderYs().flatMap((y, i) => [false, true].map((s) => ({ name: `y #${i}, sign ${s ? 1 : 0}`, raw: encodePoint(y, s) })))
}

const SPKI = (raw: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
/** R = the identity, S = 0: a signature that verifies under a small-order key for some or every message */
const FORGED = Buffer.concat([encodePoint(1n, false), Buffer.alloc(32)])

/**
 * Whether this Node's own `crypto.verify` takes the forged signature under the identity key. It does on Node 22.23.4 (every
 * message), on Node 22.14.0 and on Node 25.9.0, and does not on Node 24.22.1 or 26.13.0, which refuse a small-order key
 * themselves (measured, #1714). The repository
 * allows Node 22.14 and up and the remote host runs the pinned Node 24, so the module's own check stays and is tested on
 * every Node; only the assertions about the plain hazard need a Node that has it.
 */
const RAW_VERIFY_TAKES_SMALL_ORDER = rawVerifyTakesSmallOrder()

/** The probe, in a `try`: a Node that throws on importing a small-order key has no hazard, and the file still loads (#1714 recheck) */
function rawVerifyTakesSmallOrder(): boolean {
  try {
    return Array.from({ length: 16 }, (_, i) => verify(null, Buffer.from(`probe ${i}`), SPKI(encodePoint(1n, false)), FORGED)).some(Boolean)
  } catch {
    return false
  }
}
const HAZARD_NOTE = RAW_VERIFY_TAKES_SMALL_ORDER
  ? 'this Node has it'
  : `skipped: Node ${process.version} refuses a small-order key in crypto.verify itself, as Node 24.22.1 does; Node 22 and 25 have the hazard (doc §4.1)`

/** The pinned vector's inputs (slice 2): any other implementation of §4.3 is checked against the same */
const VECTOR = {
  hostKeyText: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  hubSeed: Buffer.alloc(32, 0x42),
  hubNonce: 'ERERERERERERERERERERERERERERERER',
  hostNonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIi',
  hostKey: 'A2fv7LgwGVpiTxc813MqA5Ga_uHxVJnPf-lewxeN2Zs',
  hubKey: 'IVL40Zt5HSRFMkLhXy6rbLfP-ntqXtMAl5YOBpiB2xI',
  keyId: 'a1b2c3d4',
  port: 4100,
  transcript:
    '0000001063656e7472616c75206c696e6b207631' +
    '00000018' + '11'.repeat(24) +
    '00000018' + '22'.repeat(24) +
    '00000020' + '0367efecb830195a624f173cd7732a03919afee1f15499cf7fe95ec3178dd99b' +
    '00000020' + '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12' +
    '00000008' + '6131623263336434' +
    '0000000e' + '3132372e302e302e313a34313030',
  hubSig: 'Y6q0TW_Mp6Nq6I-nWKbLMuLl2R47gQyrUeUjH83UxfcqP7lCAbfXY_Jk0MdBM87NK7rBia9LC3SDClsPEU6NDg',
  hostSig: 's-tDB58M1W14JInusC39R_T4fB6QTD0mTP1kge0UBd-QoqT3JXLhPdboOFk00UQPS5B9FvQgTuhNT9EP4lESAQ',
}

function vectorInput(): LinkTranscriptInput {
  return {
    hubNonce: VECTOR.hubNonce,
    hostNonce: VECTOR.hostNonce,
    hostKey: VECTOR.hostKey,
    hubKey: VECTOR.hubKey,
    keyId: VECTOR.keyId,
    address: linkAddress(VECTOR.port)!,
  }
}

const key = (text: string) => parseLinkPublicKey(text)!

/** Flip one bit of a base64url string's last character's spare bits: the same bytes under Node's lax decoding */
function withSpareBit(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = alphabet.indexOf(text.at(-1)!)
  return text.slice(0, -1) + alphabet[last ^ 1]
}

describe('the pinned test vector', () => {
  it('gives the host key derived from the key', () => {
    const { publicKey } = hostLinkKey(VECTOR.hostKeyText)
    expect(publicKey.text).toBe(VECTOR.hostKey)
    // The seed is HMAC-SHA256(key, "centralu host key v1"), as §4.1 says, wrapped as PKCS#8
    const seed = createHmac('sha256', VECTOR.hostKeyText).update('centralu host key v1').digest()
    expect(linkPublicKeyOf(linkPrivateKeyOfSeed(seed))?.text).toBe(VECTOR.hostKey)
    expect(linkPublicKeyOf(linkPrivateKeyOfSeed(VECTOR.hubSeed))?.text).toBe(VECTOR.hubKey)
  })

  it('gives the exact bytes of T and both signatures, and each verifies', () => {
    const t = linkTranscript(vectorInput())!
    expect(t.toString('hex')).toBe(VECTOR.transcript)
    const hub = linkPrivateKeyOfSeed(VECTOR.hubSeed)
    const host = hostLinkKey(VECTOR.hostKeyText).privateKey
    expect(signLink('hub', hub, t)).toBe(VECTOR.hubSig)
    expect(signLink('host', host, t)).toBe(VECTOR.hostSig)
    expect(verifyLink('hub', key(VECTOR.hubKey), t, VECTOR.hubSig)).toBe(true)
    expect(verifyLink('host', key(VECTOR.hostKey), t, VECTOR.hostSig)).toBe(true)
  })

  it('signs field(role label) ‖ T, as the plain Ed25519 of node:crypto checks it', () => {
    const t = Buffer.from(VECTOR.transcript, 'hex')
    const label = Buffer.from('centralu link hub v1', 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(label.length)
    expect(verify(null, Buffer.concat([len, label, t]), key(VECTOR.hubKey).key, Buffer.from(VECTOR.hubSig, 'base64url'))).toBe(true)
  })

  it('derives a stable key per host key and a different one for another', () => {
    expect(hostLinkKey('k1').publicKey.text).toBe(hostLinkKey('k1').publicKey.text)
    expect(hostLinkKey('k1').publicKey.text).not.toBe(hostLinkKey('k2').publicKey.text)
  })
})

describe('public keys (§4.1)', () => {
  it('derives the small-order points from the curve, and the module refuses each with either sign bit', () => {
    const encodings = smallOrderEncodings()
    // 1, p − 1, 0 and the two y of the points of order 8, each with two sign bits
    expect(encodings).toHaveLength(10)
    // The two order-8 encodings libsodium lists are among them
    const hex = encodings.map((e) => e.raw.toString('hex'))
    expect(hex).toContain('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05')
    expect(hex).toContain('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')
    for (const { name, raw } of encodings) expect(parseLinkPublicKey(raw.toString('base64url')), name).toBeNull()
  })

  it.skipIf(!RAW_VERIFY_TAKES_SMALL_ORDER)(`pins the hazard where it exists: raw node:crypto verifies a forged signature under every small-order key (${HAZARD_NOTE})`, () => {
    // So a check of the point is needed, and a test signature would not do: under order 8 only some messages pass
    for (const { name, raw } of smallOrderEncodings()) {
      const k = SPKI(raw)
      const passed = Array.from({ length: 256 }, (_, i) => verify(null, Buffer.from(`message ${i}`), k, FORGED)).filter(Boolean).length
      expect(passed, name).toBeGreaterThan(0)
    }
    // The identity: every message
    const identity = SPKI(encodePoint(1n, false))
    for (let i = 0; i < 32; i++) expect(verify(null, randomBytes(40), identity, FORGED)).toBe(true)
  })

  it('refuses y = p and y = p + 1, whatever this Node makes of them (non-canonical)', () => {
    for (const y of [P, P + 1n]) {
      for (const s of [false, true]) {
        const raw = encodePoint(y, s)
        expect(parseLinkPublicKey(raw.toString('base64url')), `${y === P ? 'p' : 'p + 1'}, sign ${s ? 1 : 0}`).toBeNull()
      }
    }
  })

  it.skipIf(!RAW_VERIFY_TAKES_SMALL_ORDER)(`pins the hazard of y = p + 1 where it exists (${HAZARD_NOTE})`, () => {
    expect(Array.from({ length: 64 }, (_, i) => verify(null, Buffer.from(`m${i}`), SPKI(encodePoint(P + 1n, false)), FORGED)).every(Boolean)).toBe(true)
  })

  it('refuses every y from p to 2^255 - 1, each with both sign bits (all 38)', () => {
    // 2^255 - p = 19 values of y, so 19 x 2 encodings: every one
    expect(P + 18n).toBe(2n ** 255n - 1n)
    const cases = Array.from({ length: 19 }, (_, i) => P + BigInt(i)).flatMap((y) => [false, true].map((sign) => encodePoint(y, sign)))
    expect(cases).toHaveLength(38)
    expect(new Set(cases.map((c) => c.toString('hex'))).size).toBe(38)
    for (const c of cases) expect(parseLinkPublicKey(c.toString('base64url')), c.toString('hex')).toBeNull()
  })

  it('takes every real Ed25519 public key, with either sign bit (property: 200 keys)', () => {
    let signBits = 0
    for (let i = 0; i < 200; i++) {
      const { publicKey } = generateKeyPairSync('ed25519')
      const parsed = linkPublicKeyOf(publicKey)
      expect(parsed).not.toBeNull()
      if (parsed!.raw[31]! & 0x80) signBits++
      expect(parseLinkPublicKey(parsed!.text)?.raw.equals(parsed!.raw)).toBe(true)
    }
    // Both halves were met, so a check that forgot to clear the sign bit would have refused many of them
    expect(signBits).toBeGreaterThan(50)
    expect(signBits).toBeLessThan(150)
  })

  it('refuses a string of the wrong length, a character outside base64url, padding, and spare bits set', () => {
    const good = VECTOR.hubKey
    expect(parseLinkPublicKey(good)).not.toBeNull()
    expect(parseLinkPublicKey(good.slice(0, 42))).toBeNull()
    expect(parseLinkPublicKey(`${good}A`)).toBeNull()
    expect(parseLinkPublicKey(`${good}=`)).toBeNull()
    expect(parseLinkPublicKey(`${good.slice(0, 42)}+`)).toBeNull()
    expect(parseLinkPublicKey(`${good.slice(0, 20)}.${good.slice(21)}`)).toBeNull()
    expect(parseLinkPublicKey(`${good.slice(0, 20)} ${good.slice(21)}`)).toBeNull()
    // The last character's two spare bits: Node's decoding gives the same 32 bytes, so the string is refused
    const spare = withSpareBit(good)
    expect(Buffer.from(spare, 'base64url').equals(Buffer.from(good, 'base64url'))).toBe(true)
    expect(parseLinkPublicKey(spare)).toBeNull()
    expect(parseLinkPublicKey(undefined)).toBeNull()
    expect(parseLinkPublicKey(42)).toBeNull()
  })
})

describe('the wire lengths (§4.3, "The bytes"), defined once in @cc/protocol', () => {
  it('are 24, 32 and 64 bytes, as 32, 43 and 86 characters', () => {
    expect([LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES]).toEqual([24, 32, 64])
    expect([LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES].map((n) => Buffer.alloc(n).toString('base64url').length)).toEqual([32, 43, 86])
  })
})

describe('strict base64url decoding (§4.3)', () => {
  it('takes exactly the canonical encoding of the given length, for nonces, keys and signatures', () => {
    const r = seeded(11)
    for (const bytes of [24, 32, 64]) {
      for (let i = 0; i < 100; i++) {
        const raw = r.bytes(bytes)
        const text = raw.toString('base64url')
        expect(text).toHaveLength({ 24: 32, 32: 43, 64: 86 }[bytes]!)
        expect(decodeBase64url(text, bytes)?.equals(raw)).toBe(true)
        // One character changed, removed or added changes the value or is refused, never names the same bytes
        expect(decodeBase64url(text.slice(1), bytes)).toBeNull()
        expect(decodeBase64url(`${text}A`, bytes)).toBeNull()
        expect(decodeBase64url(`${text.slice(0, -1)}=`, bytes)).toBeNull()
        const at = r.int(text.length)
        expect(decodeBase64url(`${text.slice(0, at)}/${text.slice(at + 1)}`, bytes)).toBeNull()
        expect(decodeBase64url(`${text.slice(0, at)}+${text.slice(at + 1)}`, bytes)).toBeNull()
      }
    }
  })

  it('refuses spare bits set in the last character of a key and of a signature', () => {
    const sig = VECTOR.hubSig
    const spare = withSpareBit(sig)
    expect(Buffer.from(spare, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true)
    expect(decodeBase64url(spare, 64)).toBeNull()
    expect(decodeBase64url(withSpareBit(VECTOR.hostKey), 32)).toBeNull()
  })

  it('refuses a non-canonical signature even though its bytes verify', () => {
    const t = linkTranscript(vectorInput())!
    expect(verifyLink('hub', key(VECTOR.hubKey), t, withSpareBit(VECTOR.hubSig))).toBe(false)
    expect(verifyLink('hub', key(VECTOR.hubKey), t, `${VECTOR.hubSig}=`)).toBe(false)
    expect(verifyLink('hub', key(VECTOR.hubKey), t, undefined)).toBe(false)
  })

  it('refuses a nonce that is not canonical, in the transcript', () => {
    expect(linkTranscript({ ...vectorInput(), hubNonce: `${VECTOR.hubNonce}=` })).toBeNull()
    expect(linkTranscript({ ...vectorInput(), hubNonce: VECTOR.hubNonce.slice(1) })).toBeNull()
    expect(linkTranscript({ ...vectorInput(), hostNonce: `+${VECTOR.hostNonce.slice(1)}` })).toBeNull()
  })
})

describe('the transcript binds every field (§4.3)', () => {
  const hub = linkPrivateKeyOfSeed(VECTOR.hubSeed)
  const t = () => linkTranscript(vectorInput())!

  it('encodes fields injectively: two lists of parts with the same concatenation give different bytes (property)', () => {
    const r = seeded(23)
    for (let i = 0; i < 300; i++) {
      const parts = Array.from({ length: 2 + r.int(6) }, () => r.bytes(r.int(6)))
      // Move one byte across a boundary between two adjacent parts
      const at = r.int(parts.length - 1)
      const left = parts[at]!
      const right = parts[at + 1]!
      if (left.length === 0 && right.length === 0) continue
      const moved = parts.slice()
      if (left.length > 0) {
        moved[at] = left.subarray(0, -1)
        moved[at + 1] = Buffer.concat([left.subarray(-1), right])
      } else {
        moved[at] = right.subarray(0, 1)
        moved[at + 1] = right.subarray(1)
      }
      expect(Buffer.concat(moved).equals(Buffer.concat(parts))).toBe(true)
      expect(encodeFields(moved).equals(encodeFields(parts))).toBe(false)
    }
  })

  it('refuses both signatures over the transcript with a byte moved between adjacent fields', () => {
    const base = ['centralu link v1', Buffer.alloc(24, 0x11), Buffer.alloc(24, 0x22), key(VECTOR.hostKey).raw, key(VECTOR.hubKey).raw, VECTOR.keyId, '127.0.0.1:4100'] as const
    expect(encodeFields(base).equals(t())).toBe(true)
    const asBytes = base.map((p) => (typeof p === 'string' ? Buffer.from(p, 'ascii') : p))
    for (let at = 0; at < asBytes.length - 1; at++) {
      const moved = asBytes.slice()
      moved[at] = asBytes[at]!.subarray(0, -1)
      moved[at + 1] = Buffer.concat([asBytes[at]!.subarray(-1), asBytes[at + 1]!])
      const forged = encodeFields(moved)
      expect(verifyLink('hub', key(VECTOR.hubKey), forged, VECTOR.hubSig), `between fields ${at} and ${at + 1}`).toBe(false)
      expect(verifyLink('host', key(VECTOR.hostKey), forged, VECTOR.hostSig), `between fields ${at} and ${at + 1}`).toBe(false)
    }
  })

  it('refuses both signatures after any one byte of T changes (property: every byte)', () => {
    const r = seeded(31)
    const base = t()
    for (let i = 0; i < base.length; i++) {
      const changed = Buffer.from(base)
      changed[i] = changed[i]! ^ (1 + r.int(255))
      expect(verifyLink('hub', key(VECTOR.hubKey), changed, VECTOR.hubSig), `byte ${i}`).toBe(false)
      expect(verifyLink('host', key(VECTOR.hostKey), changed, VECTOR.hostSig), `byte ${i}`).toBe(false)
    }
  })

  it('refuses a hub signature over another hub nonce (Nh), host nonce (Ns) or entry id', () => {
    const other = (patch: Partial<LinkTranscriptInput>) => linkTranscript({ ...vectorInput(), ...patch })!
    const sig = signLink('hub', hub, t())
    expect(verifyLink('hub', key(VECTOR.hubKey), other({ hubNonce: 'ERERERERERERERERERERERERERERERES' }), sig)).toBe(false)
    expect(verifyLink('hub', key(VECTOR.hubKey), other({ hostNonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIj' }), sig)).toBe(false)
    expect(verifyLink('hub', key(VECTOR.hubKey), other({ keyId: 'a1b2c3d5' }), sig)).toBe(false)
  })

  it('refuses a signature over another port, and never builds an address with a leading zero', () => {
    const sig = signLink('hub', hub, t())
    expect(verifyLink('hub', key(VECTOR.hubKey), linkTranscript({ ...vectorInput(), address: linkAddress(4101)! })!, sig)).toBe(false)
    // "127.0.0.1:04100" is not the address of port 4100: it is refused where it is built and where it is read
    expect(linkTranscript({ ...vectorInput(), address: '127.0.0.1:04100' })).toBeNull()
    expect(linkAddressOfDoor('ws://127.0.0.1:04100')).toBeNull()
    // And were it signed over, the bytes differ, so the signature would not carry over
    const zero = encodeFields(['centralu link v1', Buffer.alloc(24, 0x11), Buffer.alloc(24, 0x22), key(VECTOR.hostKey).raw, key(VECTOR.hubKey).raw, VECTOR.keyId, '127.0.0.1:04100'])
    expect(verifyLink('hub', key(VECTOR.hubKey), zero, sig)).toBe(false)
  })

  it('refuses a role swap: a host signature is never a hub one, nor the other way', () => {
    expect(verifyLink('hub', key(VECTOR.hostKey), t(), VECTOR.hostSig)).toBe(false)
    expect(verifyLink('host', key(VECTOR.hubKey), t(), VECTOR.hubSig)).toBe(false)
    // Even when one key signs both roles, the labels keep them apart
    const one = signLink('host', hub, t())
    expect(verifyLink('host', key(VECTOR.hubKey), t(), one)).toBe(true)
    expect(verifyLink('hub', key(VECTOR.hubKey), t(), one)).toBe(false)
  })

  it('refuses a transcript with the two public keys swapped, or another hub key', () => {
    const swapped = linkTranscript({ ...vectorInput(), hostKey: VECTOR.hubKey, hubKey: VECTOR.hostKey })!
    expect(verifyLink('hub', key(VECTOR.hubKey), swapped, VECTOR.hubSig)).toBe(false)
    expect(verifyLink('host', key(VECTOR.hostKey), swapped, VECTOR.hostSig)).toBe(false)
    const another = linkPublicKeyOf(generateKeyPairSync('ed25519').publicKey)!
    expect(verifyLink('hub', key(VECTOR.hubKey), linkTranscript({ ...vectorInput(), hubKey: another.text })!, VECTOR.hubSig)).toBe(false)
  })

  it('refuses to build a transcript from a refused key, an id not of the entry shape, or an address of another form', () => {
    const identity = encodePoint(1n, false).toString('base64url')
    expect(linkTranscript({ ...vectorInput(), hostKey: identity })).toBeNull()
    expect(linkTranscript({ ...vectorInput(), hubKey: identity })).toBeNull()
    for (const keyId of ['A1B2C3D4', 'a1b2c3d', 'a1b2c3d45', 'a1b2c3dg', '']) expect(linkTranscript({ ...vectorInput(), keyId }), keyId).toBeNull()
    for (const address of ['127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:99999', 'localhost:4100', '127.0.0.2:4100', '::1:4100', '127.0.0.1:4100 ', ' 127.0.0.1:4100', '127.0.0.1:+4100']) {
      expect(linkTranscript({ ...vectorInput(), address }), address).toBeNull()
    }
    expect(linkTranscript({ ...vectorInput(), address: '127.0.0.1:65535' })).not.toBeNull()
    expect(linkTranscript({ ...vectorInput(), address: '127.0.0.1:1' })).not.toBeNull()
  })

  it('never verifies under a small-order key, since none can be named', () => {
    expect(parseLinkPublicKey(encodePoint(1n, false).toString('base64url'))).toBeNull()
    // A key object made by a cast is refused at run time. The identity one, with the forged signature, on any Node; and a
    // lookalike of the hub's real key with its real signature, which would verify were the key let through
    const identity = { text: '', raw: encodePoint(1n, false), key: SPKI(encodePoint(1n, false)) } as unknown as LinkPublicKey
    expect(verifyLink('hub', identity, t(), FORGED.toString('base64url'))).toBe(false)
    const real = key(VECTOR.hubKey)
    const lookalike = { text: real.text, raw: real.raw, key: real.key } as unknown as LinkPublicKey
    expect(verifyLink('hub', real, t(), VECTOR.hubSig)).toBe(true)
    expect(verifyLink('hub', lookalike, t(), VECTOR.hubSig)).toBe(false)
    for (const notAKey of [undefined, null, 'x', {}, { key: real.key }]) expect(verifyLink('hub', notAKey as unknown as LinkPublicKey, t(), VECTOR.hubSig)).toBe(false)
  })

  it('knows a key only by its own mark: LinkPublicKey.is', () => {
    expect(LinkPublicKey.is(key(VECTOR.hubKey))).toBe(true)
    expect(LinkPublicKey.is({ ...key(VECTOR.hubKey) })).toBe(false)
    expect(LinkPublicKey.is(Object.create(LinkPublicKey.prototype))).toBe(false)
    expect(LinkPublicKey.is(null)).toBe(false)
    expect(LinkPublicKey.is(VECTOR.hubKey)).toBe(false)
  })

  it('takes no instance made around parse: the constructor, Reflect.construct or a subclass (#1714 recheck)', () => {
    const real = key(VECTOR.hubKey)
    const Ctor = LinkPublicKey as unknown as new (text: string, raw: Buffer, key: KeyObject) => LinkPublicKey
    const made = new Ctor(real.text, real.raw, real.key)
    const reflected = Reflect.construct(Ctor, [real.text, real.raw, real.key]) as LinkPublicKey
    class Sub extends Ctor {}
    const sub = new Sub(real.text, real.raw, real.key)
    for (const k of [made, reflected, sub]) {
      expect(LinkPublicKey.is(k)).toBe(false)
      expect(verifyLink('hub', k, t(), VECTOR.hubSig)).toBe(false)
    }
    // And a parsed key's fields stay as parsed
    expect(Object.isFrozen(real)).toBe(true)
    expect(() => Object.assign(real, { key: SPKI(encodePoint(1n, false)) })).toThrow()
  })

  it('encodes a string field as ASCII and refuses another character, which one byte per character would fold onto a character below 0x80', () => {
    // U+0100 has the low byte 0, so as one byte per character it would equal the string NUL
    expect(() => encodeFields(['\u0100'])).toThrow()
    expect(() => encodeFields(['\u00e9'])).toThrow()
    expect(() => encodeFields(['a', '\u{1F600}'])).toThrow()
    expect(encodeFields(['\0']).toString('hex')).toBe('0000000100')
    expect(encodeFields(['\x7f', 'az']).toString('hex')).toBe('000000017f000000026' + '17a')
  })

  it('refuses an empty host key, which would give one stable, guessable key', () => {
    expect(() => hostLinkKey('')).toThrow()
    expect(() => hostLinkKey(undefined as unknown as string)).toThrow()
    expect(hostLinkKey('k').publicKey.text).toHaveLength(43)
  })
})

describe('the address each side signs (§4.3)', () => {
  it('is 127.0.0.1 and the port, decimal, 1 to 65535', () => {
    expect(linkAddress(4100)).toBe('127.0.0.1:4100')
    expect(linkAddress(1)).toBe('127.0.0.1:1')
    expect(linkAddress(65535)).toBe('127.0.0.1:65535')
    for (const port of [0, -1, 65536, 4100.5, Number.NaN, '4100', undefined]) expect(linkAddress(port), String(port)).toBeNull()
  })

  it('reads an address only in the one form linkAddress writes', () => {
    expect(readLinkAddress('127.0.0.1:4100')).toBe('127.0.0.1:4100')
    for (const port of [1, 80, 4100, 65535]) expect(readLinkAddress(linkAddress(port))).toBe(linkAddress(port))
    const refused = ['127.0.0.1:04100', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:1e3', '127.0.0.1:0x10', '127.0.0.1:+4100', '127.0.0.1: 4100', '127.0.0.1:4100\n', '127.0.0.1:', '127.0.0.1', '127.0.0.1:4100.0', '127.0.0.1:99999999999999999999', '127.0.0.2:4100', '127.0.0.1:\uff14\uff11\uff10\uff10']
    for (const text of [...refused, undefined, 4100]) expect(readLinkAddress(text), String(text)).toBeNull()
  })

  it("without a keeper: the socket's own local address, an IPv4-mapped loopback read as 127.0.0.1, any other none", () => {
    expect(linkAddressOfSocket('127.0.0.1', 4100)).toBe('127.0.0.1:4100')
    expect(linkAddressOfSocket('::ffff:127.0.0.1', 4100)).toBe('127.0.0.1:4100')
    for (const a of ['::1', '0.0.0.0', '127.0.0.2', '192.168.1.2', '::ffff:127.0.0.2', undefined]) expect(linkAddressOfSocket(a, 4100), String(a)).toBeNull()
    expect(linkAddressOfSocket('127.0.0.1', undefined)).toBeNull()
  })

  it('under a keeper: the front door, exactly ws://127.0.0.1:<port>', () => {
    expect(linkAddressOfDoor('ws://127.0.0.1:4100')).toBe('127.0.0.1:4100')
    for (const door of ['ws://127.0.0.1:04100', 'ws://127.0.0.1:4100/', 'wss://127.0.0.1:4100', 'ws://localhost:4100', 'ws://127.0.0.1', 'ws://127.0.0.1:0', 'ws://127.0.0.1:65536', 'http://127.0.0.1:4100', ' ws://127.0.0.1:4100', undefined, 4100, null, {}]) {
      expect(linkAddressOfDoor(door), String(door)).toBeNull()
    }
  })

  it("a host behind a door signs the door's port, so a transcript built from the socket's inner port does not verify", () => {
    const hub = linkPrivateKeyOfSeed(VECTOR.hubSeed)
    const door = linkAddressOfDoor('ws://127.0.0.1:4100')!
    const inner = linkAddressOfSocket('127.0.0.1', 51234)!
    const sig = signLink('hub', hub, linkTranscript({ ...vectorInput(), address: door })!)
    expect(verifyLink('hub', key(VECTOR.hubKey), linkTranscript({ ...vectorInput(), address: door })!, sig)).toBe(true)
    expect(verifyLink('hub', key(VECTOR.hubKey), linkTranscript({ ...vectorInput(), address: inner })!, sig)).toBe(false)
  })
})

describe("the key hello's token marker (§4.3 step 4)", () => {
  it('is the fixed string the design names', () => {
    expect(LINK_AUTH_MARKER).toBe('centralu link auth v1')
  })

  it('is never of the shape of a drawn key or credential, nor of a derived one', () => {
    // Drawn: 32 random bytes as base64url (the key, a `--pair` credential). Derived: `ccl1:`, `ccs1:`, `ccb1:`
    expect(/^[A-Za-z0-9_-]+$/.test(LINK_AUTH_MARKER)).toBe(false)
    expect(LINK_AUTH_MARKER).not.toMatch(/^cc[lsb]1:/)
    expect(LINK_AUTH_MARKER.split(':')).toHaveLength(1)
  })

  it('is refused by sameSecret against a drawn key and by the limited, session and bridge paths (property)', () => {
    for (let i = 0; i < 50; i++) {
      const hostKey = randomBytes(32).toString('base64url')
      expect(sameSecret(LINK_AUTH_MARKER, hostKey)).toBe(false)
      expect(isLimitedToken(hostKey, LINK_AUTH_MARKER)).toBe(false)
      expect(sessionOfToken(hostKey, LINK_AUTH_MARKER)).toBeNull()
      expect(bridgeSessionOf(hostKey, LINK_AUTH_MARKER)).toBeNull()
      // And no credential those paths make is the marker
      expect(limitedToken(hostKey)).not.toBe(LINK_AUTH_MARKER)
      expect(sessionToken(hostKey, 's1')).not.toBe(LINK_AUTH_MARKER)
      expect(bridgeToken(hostKey, 's1')).not.toBe(LINK_AUTH_MARKER)
    }
  })
})
