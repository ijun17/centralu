import { z } from 'zod'
import { NormalizedEvent } from './events.js'
import { ProtocolError } from './entities.js'
import { HostHandover, HostLogon } from './host-logon.js'
import { LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES, base64urlShape } from './link-wire.js'

/** Transport envelope (docs/protocol.md §1). One WS text frame equals one value of this type. */

export const PROTOCOL_VERSION = 1

/** Where a host came from: the same record the keeper keeps for it */
export const HostBuild = z.object({
  /** The commit stamped at bundle time (`abc1234`, `abc1234-dirty`, `unknown`), or `dev` from source */
  commit: z.string(),
  protocolVersion: z.number().int(),
  version: z.string().optional(),
  /** The app bundle the build was copied from */
  bundlePath: z.string().optional(),
  /** The per-build copy the host runs from, under the data folder */
  copyDir: z.string().optional(),
})
export type HostBuild = z.infer<typeof HostBuild>

/** The fields past `streamEpoch` are each in docs/protocol.md §1 or §3 (`host.handover`) */
export const HelloServer = z.object({
  kind: z.literal('hello_ok'),
  protocolVersion: z.number(),
  /** True when afterSeq falls outside the buffer — the UI must reload the snapshot */
  resyncRequired: z.boolean().default(false),
  currentSeq: z.number().int().nonnegative(),
  /** Identifies this host lifetime; seq numbers restart with every new one */
  streamEpoch: z.string().min(1).optional(),
  /** Under the keeper a window of another build can be attached to this host; absent from an older host */
  build: HostBuild.optional(),
  /** Administrator rights: an elevated token on Windows, root elsewhere. Absent until the host finds out */
  elevated: z.boolean().optional(),
  /** A `network` logon cannot open the user's Credential Manager vault, so Git there cannot use a saved sign-in */
  logon: HostLogon.optional().catch(undefined),
  /** A sign-in's `serve` waiting to take over from this host, or one that gave up */
  handover: HostHandover.optional().catch(undefined),
  /**
   * The turns this host continues because an update cut them (`host.stop { forUpdate }`), `at` on this host's clock.
   * Empty: it continues such turns; absent: it predates that
   */
  updateContinued: z.array(z.object({ sessionId: z.string(), at: z.number() })).optional().catch(undefined),
  /** Sent when the socket authenticated with the limited credential (`'limited'`); absent on full connections and older hosts */
  rights: z.enum(['full', 'limited']).optional().catch(undefined),
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
 * Terminal output, outside the resend buffer (no seq): its volume would push out the real events, and what was missed
 * comes back whole from the host's scrollback on reattach.
 */
export const TerminalPush = z.object({
  kind: z.literal('term'),
  terminalId: z.string(),
  data: z.string(),
})
export type TerminalPush = z.infer<typeof TerminalPush>

export const TerminalExit = z.object({
  kind: z.literal('term_exit'),
  terminalId: z.string(),
  exitCode: z.number().nullable(),
})
export type TerminalExit = z.infer<typeof TerminalExit>

export const ProofServer = z.object({
  kind: z.literal('proof'),
  nonce: z.string(),
  mac: z.string(),
  /** For a `prove` naming `key` (docs/protocol.md §1). Shape only here; a hub takes the three together or none */
  hostNonce: z.string().regex(base64urlShape(LINK_NONCE_BYTES)).optional().catch(undefined),
  hostKey: z.string().regex(base64urlShape(LINK_PUBLIC_KEY_BYTES)).optional().catch(undefined),
  sig: z.string().regex(base64urlShape(LINK_SIGNATURE_BYTES)).optional().catch(undefined),
})
export type ProofServer = z.infer<typeof ProofServer>

/** A host withdraws a call it sent a hub with a reverse call of this method, `{ id }` (docs/protocol.md §1) */
export const CANCEL_CALL_METHOD = 'call.cancel'

/**
 * A hub stops the time limit of a call a host sent it while the person cannot see the work it waits on (a card the
 * person's own turn hides), `{ id, held }`; released, it runs on with what it had left (docs/protocol.md §1, §3.3).
 */
export const HOLD_CALL_METHOD = 'call.hold'
export const HoldCallParams = z.object({ id: z.string().max(200), held: z.boolean() })
export type HoldCallParams = z.infer<typeof HoldCallParams>

/** Longer than a working session at one turn, short enough that a hub never holds a call open past a working day */
export const CALL_HOLD_MAX_MS = 4 * 60 * 60_000

// 'res' splits into two branches by ok, so discriminatedUnion('kind') does not work here — use a plain union.
// `rpc` here is a host's call to a hub linked to it (`RpcAnswer`)
export const ServerFrame = z.union([
  HelloServer,
  ProofServer,
  EventPush,
  RpcResponse,
  TerminalPush,
  TerminalExit,
  RpcRequest,
])
export type ServerFrame = z.infer<typeof ServerFrame>
export function parseServerFrame(raw: unknown) {
  return ServerFrame.safeParse(raw)
}
