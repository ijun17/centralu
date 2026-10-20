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
export function connectionLine({ port, token, credential, limited, others, version, protocolVersion, dataDir, hostRunning, install, autostart, detach, proof, stopped }) {
  /*
   * The options this serve takes that an older one refuses (#1223): a hub adds `--from <its name>` to `--detach` only
   * when the line says so, since an older serve answers an option it does not know with an error. `window`: the
   * desktop window on Windows uses this serve's host through `--window` only when it is listed (#1223 review)
   */
  /*
   * `pair` (#1405): `--connection --pair <label>` hands out a full credential of its own; without it the line carries the
   * limited credential only
   */
  const takes = ['from', 'window', 'pair']
  return JSON.stringify({
    v: 1,
    port,
    // A full credential only to `--pair` (#1405), with its id for the proof; an older serve always printed its token
    ...(token ? { token } : {}),
    ...(credential ? { credential } : {}),
    // What a process of this user gets without pairing (#1405): everyday calls only
    ...(limited ? { limited } : {}),
    // The full credentials this folder holds besides the one just paired, as `{ id, label, created }` (#1405)
    ...(others ? { others } : {}),
    version,
    protocolVersion,
    dataDir,
    hostRunning,
    ...(install ? { install } : {}),
    ...(autostart ? { autostart } : {}),
    ...(detach ? { detach } : {}),
    // The running host proves it holds the token before the hub sends it (#838); absent: the hub sends hello as before
    ...(proof ? { proof: true } : {}),
    // The person stopped the host here, and when (#1143, `readStopped`); absent: an older serve, or no such stop
    ...(stopped ? { stopped } : {}),
    takes,
  })
}

/**
 * Where a `serve` was asked for from (#1223), for the host's `host.lock` (`CC_SERVE_FROM`): the hub's name `--from`
 * gave, and the ssh client's address when this runs in an ssh session (OpenSSH's `SSH_CLIENT`, on Windows too). What a
 * `--detach` found is carried to the launcher it starts (`CENTRALU_STARTED_FROM`), which runs outside the ssh session.
 * Null when neither is known.
 */
export function serveFrom(env, hub = null) {
  const carried = parseStartedFrom(env.CENTRALU_STARTED_FROM)
  if (carried) return carried
  const ssh = String(env.SSH_CLIENT ?? env.SSH_CONNECTION ?? '').trim().split(/\s+/)[0] ?? ''
  const from = {
    ...(typeof hub === 'string' && FROM_NAME_RE.test(hub) ? { hub } : {}),
    ...(SSH_ADDRESS_RE.test(ssh) ? { ssh } : {}),
  }
  return from.hub || from.ssh ? from : null
}

const FROM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
/** An IPv4 or IPv6 address as OpenSSH writes it: digits, hex, dots and colons */
const SSH_ADDRESS_RE = /^[0-9A-Fa-f.:]{2,64}$/

function parseStartedFrom(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    const from = {
      ...(typeof v?.hub === 'string' && FROM_NAME_RE.test(v.hub) ? { hub: v.hub } : {}),
      ...(typeof v?.ssh === 'string' && SSH_ADDRESS_RE.test(v.ssh) ? { ssh: v.ssh } : {}),
    }
    return from.hub || from.ssh ? from : null
  } catch {
    return null
  }
}

/**
 * The host's environment.
 *
 * - The token is in neither: arguments are readable by every user on the machine (`ps`), and a
 *   process's start environment by every process of its user for as long as it runs (`ps eww`,
 *   #502). `CC_HOST_TOKEN_ON_STDIN=1` tells the host it comes as the first line on its stdin
 *   (`tokenLine`, #538), which is a pipe to this launcher anyway (`--watch-parent`). A host bundle
 *   from before #538 reads only `CC_HOST_TOKEN`: given `legacyToken` (`takesTokenOnStdin` said no),
 *   it gets the token there, as before.
 * - `CC_HOST_SOURCE` is the record `hello_ok.build` is made from (keeper-link.ts); without it a
 *   client could not see which version the host it reached is.
 * - Headless: no `DISPLAY` / `WAYLAND_DISPLAY`. Nothing the host or an agent starts gets a screen
 *   to open a window or a keyring prompt on, so a tool that would ask falls back to its file store
 *   or fails with a message in the log instead of waiting on a dialog nobody can see.
 * - The keeper's and dev mode's variables are dropped: this host is neither. So is
 *   `CENTRALU_MANAGED`, which is the launcher's business and would otherwise reach every agent.
 * - `CC_SERVE=1` lets the host take `host.stop` (`--stop`); a host the app runs refuses it.
 */
export function hostEnv(env, { dataDir, version, hostDir, legacyToken, from = null, serveState = null }) {
  const out = { ...env }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'CC_KEEPER', 'CC_FRONT_DOOR', 'CC_DEV', 'CC_HOST_TOKEN', 'CC_HOST_TOKEN_ON_STDIN', 'CC_HOST_SOURCE', 'CC_SERVE_STATE', 'CENTRALU_MANAGED', 'CENTRALU_STARTED_FROM', 'CC_SERVE_FROM', 'CC_STARTED_BY']) delete out[k]
  /*
   * A host that checks full credentials against serve.json's verifiers (#1405, `takesVerifiers`): the file it reads at
   * each hello. A path, not a secret: the file is the user's own, 0600. Its key comes on stdin (`keyLine`)
   */
  if (serveState) out.CC_SERVE_STATE = serveState
  // Who asked for this host, for its host.lock (#1223): a second host on the folder names it when refused
  if (from) out.CC_SERVE_FROM = JSON.stringify(from)
  out.CC_DATA_DIR = dataDir
  // The host `host.stop` may end (`centralu serve --stop`): nothing else stops it in order on Windows
  out.CC_SERVE = '1'
  if (legacyToken === undefined) out.CC_HOST_TOKEN_ON_STDIN = '1'
  else out.CC_HOST_TOKEN = legacyToken
  out.CC_HOST_SOURCE = JSON.stringify({ version, bundlePath: hostDir })
  return out
}

/**
 * Whether the host at `entry` reads its token from stdin (#538): a bundle says so in `bundle-info.json`
 * (`tokenOnStdin`), as the keeper reads it; a host run from source always does. `CENTRALU_HOST_ENTRY` can point at an
 * older bundle, which would otherwise get no token and refuse every hello.
 */
export function takesTokenOnStdin(entry) {
  try {
    return JSON.parse(readFileSync(join(dirname(entry), 'bundle-info.json'), 'utf8')).tokenOnStdin === 1
  } catch {
    // not a bundle: the source, which reads it
  }
  return !existsSync(join(dirname(entry), 'bundle-info.json'))
}

/** The first line on the host's stdin: the token (#538, the host's `readHandedToken`) */
export function tokenLine(token) {
  return `${JSON.stringify({ token })}\n`
}

/**
 * The first line on the stdin of a host that takes verifiers (#1405): its key, from which it derives what it hands out.
 * Not a full credential: the host never takes it as one (`CC_SERVE_STATE` says where the full ones' verifiers are)
 */
export function keyLine(key) {
  return `${JSON.stringify({ key })}\n`
}

/**
 * Whether the host at `entry` checks full credentials against serve.json's verifiers (#1405): a bundle says so in
 * `bundle-info.json` (`verifiers`), a host run from source has `lifecycle/serve-credentials.ts`. An older one knows a
 * single token, which this launcher then keeps for it (`legacyHostTokenOf`).
 */
export function takesVerifiers(entry) {
  try {
    return JSON.parse(readFileSync(join(dirname(entry), 'bundle-info.json'), 'utf8')).verifiers === 1
  } catch {
    // not a bundle; try the source below
  }
  return existsSync(join(dirname(entry), 'lifecycle', 'serve-credentials.ts'))
}

/**
 * What this launcher says hello with to its own host, and what that host proves with to it: the limited credential
 * and the key for a host that takes verifiers, the one token an older host knows otherwise (#1405).
 */
export function ownCredentials(state, entry) {
  if (takesVerifiers(entry) || !state.legacyHostToken) return { token: state.token, proofKey: state.proofKey }
  return { token: state.legacyHostToken, proofKey: state.legacyHostToken }
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
function helloSocket({ port, token, proofKey, protocolVersion, prove, WebSocketImpl, on }) {
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
      // A host that takes verifiers proves with its key, which is not the credential this says hello with (#1405)
      if (m?.kind === 'proof' && m.nonce === nonce && m.mac === proofOf(proofKey ?? token, nonce)) return hello()
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
export function probeHost({ port, token, proofKey, protocolVersion, prove = false, timeoutMs = 2000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return tcpProbe(port, timeoutMs)
  return helloExchange({
    port, token, proofKey, protocolVersion, prove, WebSocketImpl, timeoutMs,
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
            // Which Windows logon it runs in (#1224): a `network` one is moved into the sign-in (serve-handover.mjs)
            ...(HOST_LOGONS.includes(m.logon) ? { logon: m.logon } : {}),
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

/** The logons a host's `hello_ok.logon` may name (#1224) */
const HOST_LOGONS = ['interactive', 'network', 'batch', 'service']

/**
 * One call to a running host (`method` with `params`), as `askHostToStop` makes it: a hello with the token, then the
 * call. Its result, or null when it did not answer or refused. For `host.handover` (#1224)
 */
export function askHostRpc({ port, token, proofKey, protocolVersion, prove = false, method, params = {}, timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve(null)
  return helloExchange({
    port, token, proofKey, protocolVersion, prove, WebSocketImpl, timeoutMs,
    timedOut: null,
    failed: () => null,
    on: (done) => ({
      unproven: () => done(null),
      gone: () => done(null),
      message: (m, ws) => {
        if (m.kind === 'hello_ok') ws.send(JSON.stringify({ kind: 'rpc', id: 'call', method, params }))
        else if (m.kind === 'res' && m.id === 'call') done(m.ok && m.result && typeof m.result === 'object' ? m.result : null)
        else if (m.kind === 'res' && m.ok === false) done(null)
      },
    }),
  })
}

/**
 * Asks a running host to stop (`host.stop`, an additive RPC): a hello with the token, then the call.
 * `{ ok: true }` once the host took it, `{ ok: false, message, protocolVersion? }` otherwise; the
 * last names the host's protocol when the hello was refused for it, so the caller can ask again.
 * `ifIdle` (#1224): only if nothing runs there, checked and acted on by the host in one step; `{ ok: false, busy: true }`
 * when something does. `forUpdate` (#1618): a hub's update stops it, and the host lists the turns it ends for the next one.
 */
export function askHostToStop({ port, token, proofKey, protocolVersion, prove = false, ifIdle = false, forUpdate = false, timeoutMs = 5000, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') return Promise.resolve({ ok: false, message: `Node ${process.version} has no WebSocket to ask with` })
  // With `prove`, the token goes out only to a host that proved it holds it (#838)
  return helloExchange({
    port, token, proofKey, protocolVersion, prove, WebSocketImpl, timeoutMs,
    timedOut: { ok: false, message: 'no answer in time' },
    failed: (e) => ({ ok: false, message: e.message }),
    on: (done) => ({
      unproven: () => done({ ok: false, message: 'what answers on the port did not prove it holds the token' }),
      gone: () => done({ ok: false, message: 'the connection closed' }),
      message: (m, ws) => {
        if (m.kind === 'hello_ok') ws.send(JSON.stringify({ kind: 'rpc', id: 'stop', method: 'host.stop', params: { ...(ifIdle ? { ifIdle: true } : {}), ...(forUpdate ? { forUpdate: true } : {}) } }))
        else if (m.kind === 'res' && m.id === 'stop' && m.ok && m.result?.ok === false) {
          // `ifIdle` and something runs there (#1224): nothing was changed
          done({ ok: false, busy: true, message: 'it has work running', activity: m.result.busy ?? null, calls: m.result.calls ?? 0 })
        } else if (m.kind === 'res' && m.id === 'stop') done(m.ok ? { ok: true } : { ok: false, message: m.error?.message ?? 'refused' })
        else if (m.kind === 'res' && m.ok === false) {
          const pv = m.error?.code === 'version_mismatch' ? mismatchProtocolOf(m.error) : null
          done({ ok: false, message: m.error?.message ?? 'refused', ...(pv !== null ? { protocolVersion: pv } : {}) })
        }
      },
    }),
  })
}
