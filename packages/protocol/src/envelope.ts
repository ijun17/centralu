import { z } from 'zod'
import { NormalizedEvent } from './events.js'
import { ProtocolError } from './entities.js'
import { HostHandover, HostLogon } from './host-logon.js'
import { LINK_NONCE_BYTES, LINK_PUBLIC_KEY_BYTES, LINK_SIGNATURE_BYTES, base64urlShape } from './link-wire.js'

/** Transport envelope (docs/protocol.md §1). One WS text frame equals one value of this type. */

export const PROTOCOL_VERSION = 1

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
  /** A sign-in's `serve` waiting to take over from this host, or one that gave up (#1224, `HostHandover`). Additive */
  handover: HostHandover.optional().catch(undefined),
  /**
   * The turns this host continues because an update of this machine cut them (#1618, `host.stop { forUpdate }`), with when
   * its start took each up, on this host's clock: what tells a linked hub's caller of such a session that its turn goes on
   * rather than that the link dropped. Named from the start on, before any hello is answered, whether or not the Continue
   * is in yet; one that turns out lost is no longer named. An empty list says the host continues the turns an update cuts;
   * absent, it predates that (or the field could not be read). Additive
   */
  updateContinued: z.array(z.object({ sessionId: z.string(), at: z.number() })).optional().catch(undefined),
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

export const ProofServer = z.object({
  kind: z.literal('proof'),
  nonce: z.string(),
  mac: z.string(),
  /**
   * A host's answer to a `prove` that named `key` (#1711, docs/plans/key-pairing.md §4.3): the nonce it drew for this
   * socket (24 bytes, base64url, 32 characters), the public key it signs with (32 bytes, 43 characters) and its Ed25519
   * signature over the link transcript (64 bytes, 86 characters). Only the shape is checked here; the strict decoding,
   * the key's checks and the signature are agent-host's (`link-keys.ts`). Each malformed one reads as absent, and a hub
   * takes the three together or not at all. Additive: an older hub ignores them
   */
  hostNonce: z.string().regex(base64urlShape(LINK_NONCE_BYTES)).optional().catch(undefined),
  hostKey: z.string().regex(base64urlShape(LINK_PUBLIC_KEY_BYTES)).optional().catch(undefined),
  sig: z.string().regex(base64urlShape(LINK_SIGNATURE_BYTES)).optional().catch(undefined),
})
export type ProofServer = z.infer<typeof ProofServer>

/**
 * How a host withdraws a call it sent a hub (#550): a reverse call of this method, `{ id }` naming the call. The hub
 * aborts that call's work; nothing waits on the answer to either.
 */
export const CANCEL_CALL_METHOD = 'call.cancel'

// 'res' splits into two branches by ok, so discriminatedUnion('kind') does not work here — use a plain union.
// `rpc` here is a host's call to a hub linked to it (#550, `RpcAnswer`)
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
