import { randomBytes, type KeyObject } from 'node:crypto'
import { LINK_NONCE_BYTES } from '@cc/protocol'
import type { KeyCredential } from '../lifecycle/serve-credentials.js'
import {
  decodeBase64url,
  hostLinkKey,
  linkAddressOfDoor,
  linkAddressOfSocket,
  linkTranscript,
  parseLinkPublicKey,
  signLink,
  verifyLink,
  type LinkPublicKey,
} from './link-keys.js'

/**
 * The machine's side of a hub's key pairing (#1711, docs/plans/key-pairing.md §4.3): a `centralu serve` host answers a
 * `prove` naming a key entry with its own nonce and its signature over the link transcript, and takes a hello whose
 * `auth` is the hub's signature over the same transcript. What a socket keeps between the two (`KeyProve`) is what this
 * host drew or was sent at `prove` time, never anything the hello says (§4.3, "Where each side takes each value").
 */

/** What one socket's key `prove` left for its hello: kept on that socket only, dropped at its first hello attempt (§9, item 4) */
export type KeyProve = {
  /** `Nh`, as the `prove` carried it */
  hubNonce: string
  /** `Ns`, drawn for this socket */
  hostNonce: string
  /** The key entry the `prove` named */
  keyId: string
  /** The address this host signed (`linkAddressOf`) */
  address: string
}

/**
 * The address this host signs for one accepted socket (§4.3): the front door's from `CC_FRONT_DOOR` when a keeper runs
 * it (the socket then comes from the door's relay, on the inner port), else the socket's own local address. Null gives
 * no key path, so the socket cannot be full by key.
 */
export function linkAddressOf(frontDoor: string | undefined, localAddress: string | undefined, localPort: number | undefined): string | null {
  return frontDoor !== undefined ? linkAddressOfDoor(frontDoor) : linkAddressOfSocket(localAddress, localPort)
}

/** The host's signing key, derived once from the key it was started with (§4.1): the same across a swap, the old one until a restart after `--rotate-token` */
export class HostSigningKey {
  private derived: { privateKey: KeyObject; publicKey: LinkPublicKey } | null = null
  constructor(private readonly key: string) {}

  get pair(): { privateKey: KeyObject; publicKey: LinkPublicKey } {
    this.derived ??= hostLinkKey(this.key)
    return this.derived
  }
}

/** Why a key `prove` is refused: a malformed one (the nonce not exactly 24 bytes, no address to sign), or one naming no usable entry */
export type KeyProveRefusal = 'malformed' | 'withdrawn'

/**
 * The answer to `prove { nonce, key }` (§4.3 step 2), or why it is refused. `nonce` must decode strictly to 24 bytes
 * (the schema allows 22 to 128 characters for the older proofs): anything else is malformed and gets no answer at all,
 * never the proof under the key (§9, item 2). `entry` is the key entry `key` names in `serve.json`; none (or one whose
 * public key is refused) is "withdrawn", as for a verifier entry gone, and the hub pairs anew.
 */
export function answerKeyProve(input: {
  signing: HostSigningKey
  nonce: string
  keyId: string
  entry: KeyCredential | undefined
  address: string | null
}): { refused: KeyProveRefusal } | { pending: KeyProve; fields: { hostNonce: string; hostKey: string; sig: string } } {
  if (!decodeBase64url(input.nonce, LINK_NONCE_BYTES) || input.address === null) return { refused: 'malformed' }
  if (!input.entry || input.entry.id !== input.keyId || !parseLinkPublicKey(input.entry.publicKey)) return { refused: 'withdrawn' }
  const { privateKey, publicKey } = input.signing.pair
  const hostNonce = randomBytes(LINK_NONCE_BYTES).toString('base64url')
  const transcript = linkTranscript({ hubNonce: input.nonce, hostNonce, hostKey: publicKey.text, hubKey: input.entry.publicKey, keyId: input.keyId, address: input.address })
  if (!transcript) return { refused: 'malformed' }
  return {
    pending: { hubNonce: input.nonce, hostNonce, keyId: input.keyId, address: input.address },
    fields: { hostNonce, hostKey: publicKey.text, sig: signLink('host', privateKey, transcript) },
  }
}

/**
 * The key entry a key hello is full under (§4.3 steps 4 and 5), or null. `pending` is what this socket's `prove` left
 * (none: a hello with `auth` on a socket that sent no key `prove` is refused, and nothing is taken from the hello in its
 * place, §9 item 3). `auth.key` must be the `prove`'s; the entry is read from `keys` now, as at every hello, and its
 * public key verifies the hub's signature over the transcript rebuilt from `pending` and this host's own key.
 */
export function verifyKeyHello(input: {
  signing: HostSigningKey
  pending: KeyProve | null
  auth: { key: string; sig: string } | undefined
  keys: readonly KeyCredential[]
}): KeyCredential | null {
  const { pending, auth } = input
  if (!pending || !auth || auth.key !== pending.keyId) return null
  const entry = input.keys.find((k) => k.id === pending.keyId)
  const hubKey = entry ? parseLinkPublicKey(entry.publicKey) : null
  if (!entry || !hubKey) return null
  const transcript = linkTranscript({
    hubNonce: pending.hubNonce,
    hostNonce: pending.hostNonce,
    hostKey: input.signing.pair.publicKey.text,
    hubKey: hubKey.text,
    keyId: pending.keyId,
    address: pending.address,
  })
  if (!transcript) return null
  return verifyLink('hub', hubKey, transcript, auth.sig) ? entry : null
}
