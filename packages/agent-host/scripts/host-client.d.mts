/* eslint-disable @typescript-eslint/no-explicit-any -- the smokes read the host's raw frames directly */
import type { ChildProcess } from 'node:child_process'
import type { WebSocket } from 'ws'

export type Json = Record<string, any>
export interface HostOptions {
  db?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  onEvent?: (event: Json) => void
}
export interface StartedHost {
  host: ChildProcess
  port: number
  token: string
}
export interface HostClient {
  ws: WebSocket
  events: Json[]
  call: (method: string, params?: unknown) => Promise<Json>
  next: (pred: (event: Json) => boolean, what: string, ms?: number, from?: number) => Promise<Json>
  turn: (sessionId: string, text: string, ms?: number) => Promise<Json[]>
}
export function startHost(opts?: Pick<HostOptions, 'db' | 'env'>): Promise<StartedHost>
export function connect(host: Pick<StartedHost, 'port' | 'token'>, opts?: Pick<HostOptions, 'timeoutMs' | 'onEvent'>): Promise<HostClient>
export function removeTemp(dir: string): void
export function openHost(opts?: HostOptions): Promise<HostClient & { host: ChildProcess; port: number; stop: () => Promise<void> }>
