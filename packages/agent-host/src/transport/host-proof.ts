import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The proof a host gives that it holds the token, before the token is sent (#838, the `prove` frame): an HMAC of the client's
 * nonce under the token with a label of its own, so it is never another secret derived from it (`centralu bridge token v1`,
 * `centralu http secret v1`)
 */
export function hostProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`centralu host proof v1\0${nonce}`).digest('base64url')
}

export function proofNonce(): string {
  return randomBytes(24).toString('base64url')
}

export function provesToken(token: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const want = Buffer.from(hostProof(token, nonce))
  const got = Buffer.from(mac)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The proof a `centralu serve` host gives a hub that paired (#1405): an HMAC of the nonce under the verifier of the hub's full
 * credential (`prove.credential` names which), the SHA-256 of a credential the host never holds; something else on the
 * forwarded port knows neither
 */
export function credentialProof(verifier: string, nonce: string): string {
  return createHmac('sha256', verifier).update(`centralu host proof v2\0${nonce}`).digest('base64url')
}

export function provesCredential(verifier: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const want = Buffer.from(credentialProof(verifier, nonce))
  const got = Buffer.from(mac)
  return got.length === want.length && timingSafeEqual(got, want)
}
