/** The key-pairing fields of `prove`, `proof` and `hello` (#1711, docs/plans/key-pairing.md §4.3, slice 2): additive */
import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, parseClientFrame, parseServerFrame } from './index.js'

const NONCE = 'ERERERERERERERERERERERERERERERER'
const KEY = 'IVL40Zt5HSRFMkLhXy6rbLfP-ntqXtMAl5YOBpiB2xI'
const SIG = 'Y6q0TW_Mp6Nq6I-nWKbLMuLl2R47gQyrUeUjH83UxfcqP7lCAbfXY_Jk0MdBM87NK7rBia9LC3SDClsPEU6NDg'

describe('prove.key', () => {
  it('reads the id of a key entry', () => {
    const f = parseClientFrame({ kind: 'prove', nonce: NONCE, key: 'a1b2c3d4' })
    expect(f.success && f.data.kind === 'prove' && f.data.key).toBe('a1b2c3d4')
  })

  it('reads a malformed id as absent, and a prove without it as before', () => {
    for (const key of ['A1B2C3D4', 'a1b2c3d', 42, null]) {
      const f = parseClientFrame({ kind: 'prove', nonce: NONCE, key })
      expect(f.success, String(key)).toBe(true)
      expect(f.success && f.data.kind === 'prove' && f.data.key, String(key)).toBeUndefined()
    }
    const old = parseClientFrame({ kind: 'prove', nonce: NONCE, credential: 'a1b2c3d4' })
    expect(old.success && old.data.kind === 'prove' && old.data.credential).toBe('a1b2c3d4')
  })
})

describe('proof.hostNonce, hostKey, sig', () => {
  it('reads the three when they have the wire shapes', () => {
    const f = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm', hostNonce: NONCE, hostKey: KEY, sig: SIG })
    expect(f.success).toBe(true)
    expect(f.success && f.data.kind === 'proof' && [f.data.hostNonce, f.data.hostKey, f.data.sig]).toEqual([NONCE, KEY, SIG])
  })

  it('reads each malformed one as absent and still reads the frame, as an older proof reads', () => {
    const f = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm', hostNonce: `${NONCE}A`, hostKey: `${KEY}=`, sig: SIG.slice(1) })
    expect(f.success).toBe(true)
    expect(f.success && f.data.kind === 'proof' && [f.data.hostNonce, f.data.hostKey, f.data.sig]).toEqual([undefined, undefined, undefined])
    const old = parseServerFrame({ kind: 'proof', nonce: NONCE, mac: 'm' })
    expect(old.success && old.data.kind === 'proof' && old.data.mac).toBe('m')
  })
})

describe('hello.auth', () => {
  const hello = (auth: unknown) => parseClientFrame({ kind: 'hello', token: 'centralu link auth v1', protocolVersion: PROTOCOL_VERSION, auth })

  it('reads an entry id and a signature', () => {
    const f = hello({ key: 'a1b2c3d4', sig: SIG })
    expect(f.success && f.data.kind === 'hello' && f.data.auth).toEqual({ key: 'a1b2c3d4', sig: SIG })
  })

  it('reads a malformed auth as absent, so the hello is judged by its token alone', () => {
    for (const auth of [{ key: 'a1b2c3d4' }, { sig: SIG }, { key: 'A1B2C3D4', sig: SIG }, { key: 'a1b2c3d4', sig: `${SIG}=` }, 'x', null]) {
      const f = hello(auth)
      expect(f.success, JSON.stringify(auth)).toBe(true)
      expect(f.success && f.data.kind === 'hello' && f.data.auth, JSON.stringify(auth)).toBeUndefined()
    }
  })
})
