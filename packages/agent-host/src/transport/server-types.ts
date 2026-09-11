import type { IncomingMessage } from 'node:http'
import type { ProtocolError } from '@cc/protocol'

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>

export type HostHttpResponse = Readonly<{
  status?: number
  contentType?: string
  headers?: Readonly<Record<string, string>>
  body?: string | Buffer
}>

export type HostHttpHandler = (path: string, request: IncomingMessage) => HostHttpResponse | null

export type HostServerOptions = Readonly<{
  port: number
  token: string
  onRpc: RpcHandler
  onHttp?: HostHttpHandler
  allowUpgrade?: (request: IncomingMessage) => boolean
  handshakeTimeoutMs?: number
  maxPayloadBytes?: number
  maxRpcInFlightPerSocket?: number
  maxBufferedBytes?: number
  maxSockets?: number
}>

export type SocketState = {
  authed: boolean
  closed: boolean
  inFlight: number
  handshakeTimer: ReturnType<typeof setTimeout>
}

export const DEFAULT_LIMITS = {
  handshakeTimeoutMs: 10_000,
  maxPayloadBytes: 32 * 1024 * 1024,
  maxRpcInFlightPerSocket: 64,
  maxBufferedBytes: 32 * 1024 * 1024,
  maxSockets: 128,
} as const

export function rawText(raw: string | Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8')
  return Buffer.from(raw).toString('utf8')
}

export function protocolError(err: unknown): ProtocolError {
  if (err instanceof Error) {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : 'internal'
    return { code: isProtocolCode(code) ? code : 'internal', message: err.message, retryable: false }
  }
  return { code: 'internal', message: 'Unknown error', retryable: false }
}

function isProtocolCode(code: string): code is ProtocolError['code'] {
  return ['adapter_crashed', 'tool_not_installed', 'not_logged_in', 'session_not_found', 'rate_limited', 'version_mismatch', 'internal'].includes(code)
}
