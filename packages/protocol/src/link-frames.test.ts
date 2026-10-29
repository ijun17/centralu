/** The key-pairing fields of `prove`, `proof` and `hello` (#1711, docs/plans/key-pairing.md §4.3, slice 2): additive */
import { describe, expect, it } from 'vitest'
import { LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES, PROTOCOL_VERSION, base64urlLength, base64urlShape, parseClientFrame, parseServerFrame } from './index.js'

const NONCE = 'ERERERERERERERERERERERERERERERER'
const KEY = 'IVL40Zt5HSRFMkLhXy6rbLfP-ntqXtMAl5YOBpiB2xI'
const SIG = 'Y6q0TW_Mp6Nq6I-nWKbLMuLl2R47gQyrUeUjH83UxfcqP7lCAbfXY_Jk0MdBM87NK7rBia9LC3SDClsPEU6NDg'

describe('prove.key', () => {
  it('reads the id of a key entry, a malformed one as absent, and a prove without it as before', () => {
    const f = parseClientFrame({ kind: 'prove', nonce: NONCE, key: 'a1b2c3d4' })
    expect(f.success && f.data.kind === 'prove' && f.data.key).toBe('a1b2c3d4')
    for (const key of ['A1B2C3D4', 'a1b2c3d', 42, null]) {
      const g = parseClientFrame({ kind: 'prove', nonce: NONCE, key })
      expect(g.success, String(key)).toBe(true)
      expect(g.success && g.data.kind === 'prove' && g.data.key, String(key)).toBeUndefined()
    }
    const old = parseClientFrame({ kind: 'prove', nonce: NONCE, credential: 'a1b2c3d4' })
    expect(old.success && old.data.kind === 'prove' && old.data.credential).toBe('a1b2c3d4')
  })
})

describe('proof.hostNonce, hostKey, sig', () => {
  it('reads the three in their wire shapes, each malformed one as absent, and an older proof as before', () => {
    const f = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm', hostNonce: NONCE, hostKey: KEY, sig: SIG })
    expect(f.success && f.data.kind === 'proof' && [f.data.hostNonce, f.data.hostKey, f.data.sig]).toEqual([NONCE, KEY, SIG])
    const bad = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm', hostNonce: `${NONCE}A`, hostKey: `${KEY}=`, sig: SIG.slice(1) })
    expect(bad.success).toBe(true)
    expect(bad.success && bad.data.kind === 'proof' && [bad.data.hostNonce, bad.data.hostKey, bad.data.sig]).toEqual([undefined, undefined, undefined])
    const old = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm' })
    expect(old.success && old.data.kind === 'proof' && old.data.mac).toBe('m')
  })
})

describe('hello.auth', () => {
  const hello = (auth: unknown) => parseClientFrame({ kind: 'hello', token: 'centralu link auth v1', protocolVersion: PROTOCOL_VERSION, auth })

  it('reads an entry id and a signature, and a malformed auth as absent, so the hello is judged by its token alone', () => {
    const f = hello({ key: 'a1b2c3d4', sig: SIG })
    expect(f.success && f.data.kind === 'hello' && f.data.auth).toEqual({ key: 'a1b2c3d4', sig: SIG })
    for (const auth of [{ key: 'a1b2c3d4' }, { sig: SIG }, { key: 'A1B2C3D4', sig: SIG }, { key: 'a1b2c3d4', sig: `${SIG}=` }, 'x', null]) {
      const g = hello(auth)
      expect(g.success, JSON.stringify(auth)).toBe(true)
      expect(g.success && g.data.kind === 'hello' && g.data.auth, JSON.stringify(auth)).toBeUndefined()
    }
  })
})

describe('the wire lengths, defined once (link-wire.ts)', () => {
  it('give 32, 43 and 86 characters, which the frame fields take and no other length', () => {
    expect([LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES].map(base64urlLength)).toEqual([32, 43, 86])
    expect(base64urlShape(LINK_NONCE_BYTES).test(NONCE)).toBe(true)
    expect(base64urlShape(LINK_NONCE_BYTES).test(`${NONCE}A`)).toBe(false)
    expect(base64urlShape(LINK_PUBLIC_KEY_BYTES).test(KEY)).toBe(true)
    expect(base64urlShape(LINK_PUBLIC_KEY_BYTES).test(KEY.slice(1))).toBe(false)
    expect(base64urlShape(LINK_SIGNATURE_BYTES).test(SIG)).toBe(true)
    expect(base64urlShape(LINK_SIGNATURE_BYTES).test(`${SIG}=`)).toBe(false)
    // Each encodes as many characters as the length says, for any bytes
    for (const n of [LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES]) expect(Buffer.alloc(n, 255).toString('base64url')).toMatch(base64urlShape(n))
  })
})
