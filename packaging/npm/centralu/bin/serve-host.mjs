/**
 * The host `centralu serve` runs: how it is started, and talking to a running one over its own socket
 * (a hello with the token, a proof first where the host gives one, `host.stop`).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

/**
 * The protocol a host folder speaks, from the `bundle-info.json` the bundler writes next to
 * `main.mjs`. For a host run from source (`CENTRALU_HOST_ENTRY=…/src/main.ts`) there is no bundle
 * info, so the constant is read where the bundler reads it. null when neither is there.
 */
export function protocolVersionOf(entry) {
  try {
    const v = JSON.parse(readFileSync(join(dirname(entry), 'bundle-info.json'), 'utf8')).protocolVersion
    if (Number.isInteger(v)) return v
  } catch {
    // not a bundle; try the source below
  }
  try {
    const src = readFileSync(join(dirname(entry), '..', '..', 'protocol', 'src', 'envelope.ts'), 'utf8')
    const m = /export const PROTOCOL_VERSION = (\d+)/.exec(src)
    if (m) return Number(m[1])
  } catch {
    // nothing to read
  }
  return null
}

/**
 * The `--connection` answer. The shape is the client's interface (docs/agent-host.md §4.7).
 * `install` (additive, the line stays `v: 1`) says what runs this command (`installInfo`); `detach`
 * is added by `--detach` only.
 */
export function connectionLine({ port, token, version, protocolVersion, dataDir, hostRunning, install, autostart, detach, proof }) {
  return JSON.stringify({
    v: 1,
    port,
    token,
    version,
    protocolVersion,
    dataDir,
    hostRunning,
    ...(install ? { install } : {}),
    ...(autostart ? { autostart } : {}),
    ...(detach ? { detach } : {}),
    // The running host proves it holds the token before the hub sends it (#838); absent: the hub sends hello as before
    ...(proof ? { proof: true } : {}),
  })
}

/**
 * The host's environment.
 *
 * - The token travels in `CC_HOST_TOKEN`, not `--token`: arguments are readable by every user on
 *   the machine (`ps`), a process's environment only by its owner. The host deletes it after
 *   reading, so nothing it spawns inherits it.
 * - `CC_HOST_SOURCE` is the record `hello_ok.build` is made from (keeper-link.ts); without it a
 *   client could not see which version the host it reached is.
 * - Headless: no `DISPLAY` / `WAYLAND_DISPLAY`. Nothing the host or an agent starts gets a screen
 *   to open a window or a keyring prompt on, so a tool that would ask falls back to its file store
 *   or fails with a message in the log instead of waiting on a dialog nobody can see.
 * - The keeper's and dev mode's variables are dropped: this host is neither. So is
 *   `CENTRALU_MANAGED`, which is the launcher's business and would otherwise reach every agent.
 * - `CC_SERVE=1` lets the host take `host.stop` (`--stop`); a host the app runs refuses it.
 */
export function hostEnv(env, { token, dataDir, version, hostDir }) {
  const out = { ...env }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'CC_KEEPER', 'CC_FRONT_DOOR', 'CC_DEV', 'CC_HOST_TOKEN', 'CC_HOST_SOURCE', 'CENTRALU_MANAGED']) delete out[k]
  out.CC_DATA_DIR = dataDir
  // The host `host.stop` may end (`centralu serve --stop`): nothing else stops it in order on Windows
  out.CC_SERVE = '1'
  out.CC_HOST_TOKEN = token
  out.CC_HOST_SOURCE = JSON.stringify({ version, bundlePath: hostDir })
  return out
}

/**
 * How to start the host.
 *
 * `--watch-parent` with stdin a pipe: if this launcher dies however it dies (SIGKILL included), the
 * pipe closes and the host shuts down with its children, instead of living on unsupervised.
 * `detached` on POSIX puts the host in its own process group, so the terminal's Ctrl+C reaches
 * only this launcher, which passes one SIGINT to the host alone; the host then stops its own
 * children in order. Without it the terminal would signal every agent at the same time as the
 * host. Not on Windows: there `detached` means a new console, and Ctrl+C reaches the host through
 * the console it shares with this launcher.
 */
export function hostCommand(execPath, entry, { port, dataDir, platform }) {
  return {
    command: execPath,
    args: [
      // A source entry (development, tests) needs the TypeScript loader; a bundle does not.
      ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []),
      entry,
      '--port',
      String(port),
      '--db',
      join(dataDir, 'store.db'),
      '--watch-parent',
    ],
    detached: platform !== 'win32',
  }
}

/** The port from the host's ready line (`{"ready":true,"port":…,"token":…}`), null for any other line */
export function readyPort(line) {
  try {
    const v = JSON.parse(line)
    return v?.ready === true && Number.isInteger(v.port) ? v.port : null
  } catch {
    return null
  }
}

/**
 * The protocol a host's `version_mismatch` refusal names, from either wording: this one's
 * ("this host speaks protocol 2") or the one before it ("server 2, client 1"). null if neither.
 */
export function mismatchServerVersion(message) {
  const m = /host speaks protocol (\d+)|\bserver (\d+)/.exec(String(message ?? ''))
  return m ? Number(m[1] ?? m[2]) : null
}

/**
 * The protocol a `version_mismatch` refusal says the host speaks: `data.protocolVersion`, which the host sends for a
 * program to read (server.ts), else the sentence (`mismatchServerVersion`). null when neither names one.
 */
function mismatchProtocolOf(error) {
  if (Number.isInteger(error?.data?.protocolVersion)) return error.data.protocolVersion
  return mismatchServerVersion(error?.message)
}

/**
 * Whether the installed host answers a `prove` (#838): a bundle says so in `bundle-info.json` (`hostProof`), a host run
 * from source has `transport/host-proof.ts`. The connection line's `proof` is this, not a live answer: a program another
 * account put on the port could otherwise answer the probe so as to make the line say no, and the hub send the token.
 */
export function hostProvesOf(entry) {
  try {
    return JSON.parse(readFileSync(join(dirname(entry), 'bundle-info.json'), 'utf8')).hostProof === 1
  } catch {
    // not a bundle; try the source below
  }
  return existsSync(join(dirname(entry), 'transport', 'host-proof.ts'))
}

/** The answer a host holding `token` gives to a `prove` of `nonce` (the host's `hostProof`) */
function proofOf(token, nonce) {
  return createHmac('sha256', token).update(`centralu host proof v1\0${nonce}`).digest('base64url')
}

/**
 * Opens a socket to the host and says hello with the token, the way `probeHost` and `askHostToStop` do. With `prove`
 * (the installed host can, `hostProvesOf`), the host first proves it holds the token (#838), and the token goes out only
 * then: whatever else listens on the port (another account's program, while the host is down) never sees it.
 * `on.message(m, ws)` gets every frame after the hello; `on.unproven()` runs when the proof did not come, `on.gone()`
 * when the socket failed or closed.
 */
function helloSocket({ port, token, protocolVersion, prove, WebSocketImpl, on }) {
  const ws = new WebSocketImpl(`ws://127.0.0.1:${port}`)
  const nonce = prove ? randomBytes(24).toString('base64url') : null
  // Proving only once the socket is open: a port where nothing listens is gone, not unproven
  let proving = false
  const hello = () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: protocolVersion ?? 0 }))
  ws.onopen = () => {
    if (!prove) return hello()
    proving = true
    ws.send(JSON.stringify({ kind: 'prove', nonce }))
  }
  ws.onmessage = (ev) => {
    let m
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      m = null
    }
    if (proving) {
      proving = false
      if (m?.kind === 'proof' && m.nonce === nonce && m.mac === proofOf(token, nonce)) return hello()
      return on.unproven()
    }
    if (m) on.message(m, ws)
  }
  ws.onerror = () => (proving ? on.unproven() : on.gone())
  ws.onclose = () => (proving ? on.unproven() : on.gone())
  return ws
}

/**
 * Whether a host that holds this token answers on the port: a real hello, not a TCP connect, so a
 * stranger's program on the same port does not count, and the answer carries the running host's
 * own protocol and version (which differ from the installed package's after an `npm i -g` the
 * host was not restarted for). With `prove` the host proves it holds the token first (#838).
 *
 * `{ running, protocolVersion?, version?, unproven? }`. `unproven`: something answered on the port but did not prove
 * it holds the token, so it was not sent: another program, or a host from before #838 still running after an update
 * (`heldHere` tells those apart by the data folder's lock). Node 22.4+ has a global WebSocket; on an older 22 this falls
 * back to a TCP connect and reports only `running`.
 */
export function probeHost({ port, token, protocolVersion, prove = false, timeoutMs = 2000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return tcpProbe(port, timeoutMs)
  return helloExchange({
    port, token, protocolVersion, prove, WebSocketImpl, timeoutMs,
    timedOut: { running: false },
    failed: () => ({ running: false }),
    on: (done) => ({
      unproven: () => done({ running: false, unproven: true }),
      gone: () => done({ running: false }),
      message: (m) => {
        if (m.kind === 'hello_ok') {
          done({
            running: true,
            protocolVersion: Number.isInteger(m.protocolVersion) ? m.protocolVersion : undefined,
            version: typeof m.build?.version === 'string' ? m.build.version : undefined,
          })
        } else if (m.kind === 'res' && m.ok === false && m.error?.code === 'version_mismatch') {
          // The token was right (it is checked first), so this is our host, on another protocol
          done({ running: true, protocolVersion: mismatchProtocolOf(m.error) ?? undefined })
        }
      },
    }),
  })
}

/**
 * One `helloSocket` exchange that ends once: with the first `done(result)` an `on` handler calls, with `timedOut`
 * after `timeoutMs`, or with `failed(error)` when the socket cannot even be made. The socket is closed in every case.
 */
function helloExchange({ timeoutMs, timedOut, failed, on, ...hello }) {
  return new Promise((resolve) => {
    let ws = null
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(() => done(timedOut), timeoutMs)
    try {
      ws = helloSocket({ ...hello, on: on(done) })
    } catch (e) {
      done(failed(e))
    }
  })
}

function tcpProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port })
    const done = (running) => {
      s.destroy()
      resolve({ running })
    }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/**
 * Asks a running host to stop (`host.stop`, an additive RPC): a hello with the token, then the call.
 * `{ ok: true }` once the host took it, `{ ok: false, message, protocolVersion? }` otherwise; the
 * last names the host's protocol when the hello was refused for it, so the caller can ask again.
 */
export function askHostToStop({ port, token, protocolVersion, prove = false, timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve({ ok: false, message: `Node ${process.version} has no WebSocket to ask with` })
  // With `prove`, the token goes out only to a host that proved it holds it (#838)
  return helloExchange({
    port, token, protocolVersion, prove, WebSocketImpl, timeoutMs,
    timedOut: { ok: false, message: 'no answer in time' },
    failed: (e) => ({ ok: false, message: e.message }),
    on: (done) => ({
      unproven: () => done({ ok: false, message: 'what answers on the port did not prove it holds the token' }),
      gone: () => done({ ok: false, message: 'the connection closed' }),
      message: (m, ws) => {
        if (m.kind === 'hello_ok') ws.send(JSON.stringify({ kind: 'rpc', id: 'stop', method: 'host.stop', params: {} }))
        else if (m.kind === 'res' && m.id === 'stop') done(m.ok ? { ok: true } : { ok: false, message: m.error?.message ?? 'refused' })
        else if (m.kind === 'res' && m.ok === false) {
          const pv = m.error?.code === 'version_mismatch' ? mismatchProtocolOf(m.error) : null
          done({ ok: false, message: m.error?.message ?? 'refused', ...(pv !== null ? { protocolVersion: pv } : {}) })
        }
      },
    }),
  })
}
