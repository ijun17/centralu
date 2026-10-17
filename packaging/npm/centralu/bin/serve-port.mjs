/** The port `centralu serve` listens on: the default, the recorded one, and the next free one (#482) */
import { createServer } from 'node:net'
import { runCaptured } from './serve-util.mjs'
import { detachHow, windowsTool } from './serve-windows.mjs'

/**
 * The port `serve` listens on unless told otherwise, and keeps across restarts.
 *
 * Stable, because the client is told it once per connection and the person may write it into an
 * SSH config or a systemd unit. Below 20000 on purpose: every OS lends ports from its ephemeral
 * range to outgoing connections (Linux 32768–60999, macOS and Windows 49152–65535), and the host
 * itself hands out per-app view origins from 20000–32767 (views/origin-ports.ts). A default inside
 * either range could be taken by something transient the day the host restarts.
 */
export const DEFAULT_SERVE_PORT = 17175

/** How many ports from the recorded one `serve` tries when it is taken (#482); none at or above 20000 */
export const SERVE_PORT_TRIES = 20

/**
 * The port `serve` starts the host on (#482): `{ port, from }`, `from` being the port it moved away
 * from (null when it did not), or null when every candidate is taken.
 *
 * A port the person gave (`--port`) is used as given: they asked for that one. Otherwise the recorded
 * port (else the default) when it is free, and when another program listens there, the next free
 * one above it, below 20000 (the ranges `DEFAULT_SERVE_PORT` keeps out of). The host's ready line
 * then records the port it got, so `--connection` reports it and the hub forwards to it.
 *
 * The usual other program is the other half of one Windows laptop: WSL2 relays a distro's
 * 127.0.0.1 ports to Windows (`wslrelay.exe`), so a Windows install and a WSL install linked as two
 * machines both wanted 17175, and whichever started second could not start at all.
 * `taken(port)` answers whether something listens there.
 */
export async function chooseServePort({ asked, recorded, taken }) {
  if (asked !== null && asked !== undefined) return { port: asked, from: null }
  const first = recorded ?? DEFAULT_SERVE_PORT
  for (let p = first; p < first + SERVE_PORT_TRIES && p <= 65535; p++) {
    if (p !== first && p >= 20000) break
    if (!(await taken(p))) return { port: p, from: p === first ? null : first }
  }
  return null
}

/** Whether something listens on 127.0.0.1:`port` here: a listen that fails with EADDRINUSE (or EACCES) */
export function listensHere(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', (e) => resolve(e?.code === 'EADDRINUSE' || e?.code === 'EACCES'))
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(false)))
  })
}

/**
 * The TCP ports Windows listens on, from `netstat.exe -an -p TCP` output: a listening socket is the
 * row whose foreign address is `0.0.0.0:0` (or `[::]:0`). Read that way rather than by the state
 * column, which Windows translates (a Korean Windows does not print LISTENING everywhere).
 */
export function parseNetstatListening(text) {
  const ports = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0)\s/i.exec(line)
    if (m) ports.add(Number(m[1]))
  }
  return ports
}

/**
 * The ports the Windows side listens on, seen from inside a WSL distro (empty elsewhere, or when
 * Windows cannot be asked). Inside the distro a port Windows holds looks free, yet a host there
 * would be unreachable from the hub: the hub's forward ends on Windows' 127.0.0.1, where the
 * Windows program answers instead (#482).
 */
export async function windowsListening(env, platform) {
  if (detachHow(platform, env) !== 'wsl') return new Set()
  const netstat = windowsTool('wsl', env, ['System32', 'netstat.exe'])
  if (!netstat) return new Set()
  const r = await runCaptured(netstat, ['-an', '-p', 'TCP'], env)
  return r.code === 0 ? parseNetstatListening(r.stdout) : new Set()
}
