import { z } from 'zod'
import { NormalizedEvent } from './events.js'
import { ProtocolError } from './entities.js'

/** 전송 봉투 (docs/protocol.md §1). WS 텍스트 프레임 1개 = 이 타입 1개. */

export const PROTOCOL_VERSION = 1

export const HelloClient = z.object({
  kind: z.literal('hello'),
  token: z.string(),
  protocolVersion: z.number(),
  /** 재연결 시 유실분 재전송 요청 (없으면 전부 새로) */
  afterSeq: z.number().optional(),
})
export type HelloClient = z.infer<typeof HelloClient>

export const HelloServer = z.object({
  kind: z.literal('hello_ok'),
  protocolVersion: z.number(),
  /** afterSeq가 버퍼 밖이면 true — UI는 스냅샷을 다시 로드해야 한다 */
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

export const ClientFrame = z.discriminatedUnion('kind', [HelloClient, RpcRequest])
export type ClientFrame = z.infer<typeof ClientFrame>

// 'res'가 ok별로 두 갈래라 discriminatedUnion('kind')를 못 쓴다 — 일반 union 사용
export const ServerFrame = z.union([HelloServer, EventPush, RpcResponse])
export type ServerFrame = z.infer<typeof ServerFrame>

export function parseClientFrame(raw: unknown) {
  return ClientFrame.safeParse(raw)
}
export function parseServerFrame(raw: unknown) {
  return ServerFrame.safeParse(raw)
}
