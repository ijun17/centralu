import { z } from 'zod'
import { NormalizedEvent } from './events.js'
import { ProtocolError } from './entities.js'

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

export const ClientFrame = z.discriminatedUnion('kind', [HelloClient, RpcRequest])
export type ClientFrame = z.infer<typeof ClientFrame>

// 'res' splits into two branches by ok, so discriminatedUnion('kind') does not work here — use a plain union
export const ServerFrame = z.union([HelloServer, EventPush, RpcResponse, TerminalPush, TerminalExit])
export type ServerFrame = z.infer<typeof ServerFrame>

export function parseClientFrame(raw: unknown) {
  return ClientFrame.safeParse(raw)
}
export function parseServerFrame(raw: unknown) {
  return ServerFrame.safeParse(raw)
}
