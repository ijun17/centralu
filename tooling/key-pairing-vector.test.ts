/** The key-pairing vector, made by a separate Ed25519 (`key-pairing-vector.mjs`), is what the module gives (#1711, slice 2) */
import { describe, expect, it } from 'vitest'
import { vector } from './key-pairing-vector.mjs'
import { hostLinkKey, linkAddress, linkPrivateKeyOfSeed, linkPublicKeyOf, linkTranscript, signLink } from '../packages/agent-host/src/transport/link-keys.js'

describe('the key-pairing test vector', () => {
  it('is the same from a separate Ed25519 and from link-keys.ts: both keys, the bytes of T and both signatures', () => {
    const v = vector()
    const hubKey = linkPrivateKeyOfSeed(Buffer.alloc(32, 0x42))
    const host = hostLinkKey('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')
    expect(host.publicKey.text).toBe(v.hostKey)
    expect(linkPublicKeyOf(hubKey)?.text).toBe(v.hubKey)
    const t = linkTranscript({
      hubNonce: Buffer.alloc(24, 0x11).toString('base64url'),
      hostNonce: Buffer.alloc(24, 0x22).toString('base64url'),
      hostKey: v.hostKey,
      hubKey: v.hubKey,
      keyId: 'a1b2c3d4',
      address: linkAddress(4100)!,
    })!
    expect(t.toString('hex')).toBe(v.transcript)
    expect(signLink('hub', hubKey, t)).toBe(v.hubSig)
    expect(signLink('host', host.privateKey, t)).toBe(v.hostSig)
  })
})
