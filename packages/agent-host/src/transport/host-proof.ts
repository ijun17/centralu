import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The proof a host gives that it holds the token, before the token is sent (#838, the `prove` frame). An HMAC of the
 * client's nonce under the token, after a label of its own, so it is never the value of another secret derived from
 * the same token (`centralu bridge token v1`, `centralu http secret v1`).
 */
export function hostProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`centralu host proof v1\0${nonce}`).digest('base64url')
}

/** A fresh nonce for one `prove` */
export function proofNonce(): string {
  return randomBytes(24).toString('base64url')
}

/** Whether `mac` is the proof of `nonce` under `token`, compared in constant time */
export function provesToken(token: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const want = Buffer.from(hostProof(token, nonce))
  const got = Buffer.from(mac)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The proof a `centralu serve` host gives a hub that paired (#1405): an HMAC of the nonce under the verifier of the
 * hub's full credential (`prove.credential` names which), the SHA-256 of a credential the host never holds. The hub
 * derives the verifier from the credential it was given; something else on the forwarded port knows neither.
 */
export function credentialProof(verifier: string, nonce: string): string {
  return createHmac('sha256', verifier).update(`centralu host proof v2\0${nonce}`).digest('base64url')
}

/** Whether `mac` is the proof of `nonce` under the verifier of `credential`, compared in constant time */
export function provesCredential(verifier: string, nonce: string, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const want = Buffer.from(credentialProof(verifier, nonce))
  const got = Buffer.from(mac)
  return got.length === want.length && timingSafeEqual(got, want)
}
