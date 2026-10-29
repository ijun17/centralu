import { z } from 'zod'
import { ProtocolError } from './entities.js'
import { RpcRequest } from './envelope.js'
import { LINK_SIGNATURE_BYTES, base64urlShape } from './link-wire.js'

/** The frames a client sends, which only the host parses: the UI's bundle leaves them out (#1648). */

export const HelloClient = z.object({
  kind: z.literal('hello'),
  token: z.string(),
  protocolVersion: z.number(),
  /** Request resend of what was missed on reconnect (omit to receive everything fresh) */
  afterSeq: z.number().int().nonnegative().optional(),
  /**
   * The host lifetime that issued `afterSeq`, as received in `hello_ok` (#82). A cursor is
   * honoured only together with the current lifetime's epoch; any other cursor gets a resync.
   */
  streamEpoch: z.string().min(1).max(200).optional(),
  /**
   * What this client can show (#1405): a window says `host_requests` (`SHOWS_HOST_REQUESTS`), and the host raises a
   * request from a limited caller only while a window holding the token said so. Unknown entries are ignored. Additive
   */
  shows: z.array(z.string().max(40)).max(16).optional().catch(undefined),
  /**
   * What the program calls itself (#1405), for a card its call raises: never checked, shown quoted, cut to 60
   * characters by the host. Additive
   */
  client: z.string().max(200).optional().catch(undefined),
  /**
   * A hub's key pairing (#1711, docs/plans/key-pairing.md §4.3): the id of the hub's key entry in the machine's
   * `serve.json` and the hub's Ed25519 signature over the link transcript, base64url (86 characters). `token` then
   * carries the fixed marker `LINK_AUTH_MARKER` (agent-host `link-keys.ts`). Only the shape is checked here; the
   * strict decoding and the signature are agent-host's. Malformed reads as absent. Additive: an older host ignores it
   */
  auth: z
    .object({
      key: z.string().regex(/^[0-9a-f]{8}$/),
      sig: z.string().regex(base64urlShape(LINK_SIGNATURE_BYTES)),
    })
    .optional()
    .catch(undefined),
})
export type HelloClient = z.infer<typeof HelloClient>
/**
 * Before hello, a client may ask the host to prove it holds the token, without either side sending it (#838): the
 * hub's ssh forward listens on a loopback port any local account can take first, and the hello carries the token.
 * The host answers `proof` with an HMAC of the nonce under its token (`hostProof` in agent-host). At most one per
 * socket, and it authenticates nothing: a hello still has to follow.
 */
export const ProveClient = z.object({
  kind: z.literal('prove'),
  /** Fresh random, base64url: the HMAC's input after a fixed label, so no other value derived from the token can be asked for */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
  /**
   * Which full credential the asker holds (#1405, `centralu serve --pair`'s id): a serve host proves with that
   * credential's verifier (`credentialProof`, label `centralu host proof v2`). Absent: the proof under the host's own
   * key, as before. Additive: an older host ignores it
   */
  credential: z.string().regex(/^[0-9a-f]{8}$/).optional().catch(undefined),
  /**
   * Which key entry the asker paired (#1711, docs/plans/key-pairing.md §4.3, the id `--pair-key` reported): a host
   * that takes key hellos answers with its own nonce, its public key and its signature over the link transcript
   * (`ProofServer`). Malformed reads as absent. Additive: an older host ignores it and answers with a mac only
   */
  key: z.string().regex(/^[0-9a-f]{8}$/).optional().catch(undefined),
})
export type ProveClient = z.infer<typeof ProveClient>
/**
 * The reverse direction (#550, docs/plans/remote-hub.md §12.7): a host calls a hub linked to it, over the socket the hub
 * opened. The call is an `RpcRequest` sent by the host, and only to a socket whose hub said it answers them
 * (`host.hubOffer`); the hub answers it with this frame under the same id. Ids of the two directions never meet: a host
 * reads an answer only for a call it sent on that socket. A hub without a handler for the reverse direction (any build
 * before it) drops the call; a host from before it answers this frame with "Unknown frame", which nothing waits on.
 */
export const RpcAnswer = z.object({
  kind: z.literal('res'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: ProtocolError.optional(),
})
export type RpcAnswer = z.infer<typeof RpcAnswer>
export const ClientFrame = z.discriminatedUnion('kind', [HelloClient, ProveClient, RpcRequest, RpcAnswer])
export type ClientFrame = z.infer<typeof ClientFrame>
export function parseClientFrame(raw: unknown) {
  return ClientFrame.safeParse(raw)
}
