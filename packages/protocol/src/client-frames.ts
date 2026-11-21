import { z } from 'zod'
import { ProtocolError } from './entities.js'
import { RpcRequest } from './envelope.js'
import { LINK_SIGNATURE_BYTES, base64urlShape } from './link-wire.js'

/** The frames a client sends, which only the host parses: the UI's bundle leaves them out. */

export const HelloClient = z.object({
  kind: z.literal('hello'),
  token: z.string(),
  protocolVersion: z.number(),
  /** Resend what came after this seq; absent on first contact (docs/protocol.md §1) */
  afterSeq: z.number().int().nonnegative().optional(),
  /** The host lifetime `afterSeq` came from (`hello_ok.streamEpoch`); a cursor of another epoch gets a resync */
  streamEpoch: z.string().min(1).max(200).optional(),
  /**
   * `host_requests` (`SHOWS_HOST_REQUESTS`): this window shows a limited caller's card, and the host raises one only
   * while such a window holds the token. Unknown entries are ignored
   */
  shows: z.array(z.string().max(40)).max(16).optional().catch(undefined),
  /** What the program calls itself, for a card its call raises: never checked, shown quoted, cut to 60 characters */
  client: z.string().max(200).optional().catch(undefined),
  /** A hub's key pairing (docs/protocol.md §1); `token` is then `LINK_AUTH_MARKER`. Shape only: agent-host checks it */
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
 * The host proves it holds the token before the hello carries it, since a hub's ssh forward listens on a loopback port
 * any local account can take first (docs/protocol.md §1 "A proof before the hello"). It authenticates nothing.
 */
export const ProveClient = z.object({
  kind: z.literal('prove'),
  /** The HMAC's input after a fixed label, so no other value derived from the token can be asked for */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
  /** The full credential the asker holds (`serve --pair`'s id): the proof is under its verifier, not the host's key */
  credential: z.string().regex(/^[0-9a-f]{8}$/).optional().catch(undefined),
  /** The key entry the asker paired (`--pair-key`'s id): the host answers with a signature (`ProofServer`) */
  key: z.string().regex(/^[0-9a-f]{8}$/).optional().catch(undefined),
})
export type ProveClient = z.infer<typeof ProveClient>
/** A hub's answer to a host's reverse call (docs/protocol.md §1); a host reads it only for a call it sent on that socket */
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
