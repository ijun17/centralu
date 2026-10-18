import { z } from 'zod'
import { NormalizedEvent } from './events.js'
import { ProtocolError } from './entities.js'
import { HostLogon } from './host-logon.js'

/** Transport envelope (docs/protocol.md §1). One WS text frame equals one value of this type. */

export const PROTOCOL_VERSION = 1

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
})
export type HelloClient = z.infer<typeof HelloClient>

/** Where a host came from (#280) — the same record the keeper keeps for it */
export const HostBuild = z.object({
  /** The commit stamped at bundle time (`abc1234`, `abc1234-dirty`, `unknown`), or `dev` from source */
  commit: z.string(),
  protocolVersion: z.number().int(),
  /** The app version the build shipped as */
  version: z.string().optional(),
  /** The app bundle the build was copied from */
  bundlePath: z.string().optional(),
  /** The per-build copy the host runs from, under the data folder */
  copyDir: z.string().optional(),
})
export type HostBuild = z.infer<typeof HostBuild>

export const HelloServer = z.object({
  kind: z.literal('hello_ok'),
  protocolVersion: z.number(),
  /** True when afterSeq falls outside the buffer — the UI must reload the snapshot */
  resyncRequired: z.boolean().default(false),
  currentSeq: z.number().int().nonnegative(),
  /** Identifies this host lifetime; seq numbers restart with every new one (#82) */
  streamEpoch: z.string().min(1).optional(),
  /**
   * Which build this host is and where it came from (#280). A window of another build can be
   * attached to this host through the keeper, and has to be able to tell. Optional: a host run
   * from source has only `commit: 'dev'`, and an older host sends nothing.
   */
  build: HostBuild.optional(),
  /**
   * The host runs with administrator rights (#702): an elevated token on Windows, as Windows OpenSSH gives an
   * administrator's network logon, or root elsewhere. Absent when the host could not tell yet, or predates it. Additive
   */
  elevated: z.boolean().optional(),
  /**
   * Which Windows logon the host runs in (#1224): `interactive` is the person's own sign-in (or a task that runs in it),
   * `network` what Windows OpenSSH gives a key login, which cannot open the user's Credential Manager vault, so Git
   * there cannot use a sign-in saved in Windows. Absent off Windows, when the host could not tell, or predates it; a
   * value this build does not know reads as absent. Additive
   */
  logon: HostLogon.optional().catch(undefined),
})
export type HelloServer = z.infer<typeof HelloServer>

export const RpcRequest = z.object({
  kind: z.literal('rpc'),
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
})
export type RpcRequest = z.infer<typeof RpcRequest>

export const RpcResponse = z.union([
  z.object({ kind: z.literal('res'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('res'), id: z.string(), ok: z.literal(false), error: ProtocolError }),
])
export type RpcResponse = z.infer<typeof RpcResponse>

export const EventPush = z.object({
  kind: z.literal('event'),
  seq: z.number(),
  event: NormalizedEvent,
})
export type EventPush = z.infer<typeof EventPush>

/**
 * Terminal output. **Does not go through the resend buffer (seq)** — its volume is an order
 * of magnitude larger than conversation events, and anything missed is received whole from the
 * host's scrollback on reattach. Mixing it into the ring buffer would push out the real events.
 */
export const TerminalPush = z.object({
  kind: z.literal('term'),
  terminalId: z.string(),
  data: z.string(),
})
export type TerminalPush = z.infer<typeof TerminalPush>

/** The terminal has ended (the shell exited). The UI offers a way to reattach. */
export const TerminalExit = z.object({
  kind: z.literal('term_exit'),
  terminalId: z.string(),
  exitCode: z.number().nullable(),
})
export type TerminalExit = z.infer<typeof TerminalExit>

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
})
export type ProveClient = z.infer<typeof ProveClient>

export const ProofServer = z.object({
  kind: z.literal('proof'),
  nonce: z.string(),
  mac: z.string(),
})
export type ProofServer = z.infer<typeof ProofServer>

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

/**
 * How a host withdraws a call it sent a hub (#550): a reverse call of this method, `{ id }` naming the call. The hub
 * aborts that call's work; nothing waits on the answer to either.
 */
export const CANCEL_CALL_METHOD = 'call.cancel'

export const ClientFrame = z.discriminatedUnion('kind', [HelloClient, ProveClient, RpcRequest, RpcAnswer])
export type ClientFrame = z.infer<typeof ClientFrame>

// 'res' splits into two branches by ok, so discriminatedUnion('kind') does not work here — use a plain union.
// `rpc` here is a host's call to a hub linked to it (#550, `RpcAnswer`)
export const ServerFrame = z.union([HelloServer, ProofServer, EventPush, RpcResponse, TerminalPush, TerminalExit, RpcRequest])
export type ServerFrame = z.infer<typeof ServerFrame>

export function parseClientFrame(raw: unknown) {
  return ClientFrame.safeParse(raw)
}
export function parseServerFrame(raw: unknown) {
  return ServerFrame.safeParse(raw)
}
