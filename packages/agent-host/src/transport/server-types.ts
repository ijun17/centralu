export type RpcHandler = (method: string, params: unknown) => Promise<unknown>

export type HostServerOptions = Readonly<{
  port: number
  token: string
  onRpc: RpcHandler
  onHttp?: (path: string) => { body: string | Buffer; contentType: string } | null
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
