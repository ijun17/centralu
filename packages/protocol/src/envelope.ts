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
  afterSeq: z.number().optional(),
})
export type HelloClient = z.infer<typeof HelloClient>

export const HelloServer = z.object({
  kind: z.literal('hello_ok'),
  protocolVersion: z.number(),
  /** True when afterSeq falls outside the buffer — the UI must reload the snapshot */
  resyncRequired: z.boolean().default(false),
  currentSeq: z.number(),
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
