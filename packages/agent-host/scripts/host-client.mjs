/**
 * A host and its WebSocket, the way the smoke scripts drive them: `main.ts` started on a port of its own, `hello` said,
 * RPC calls made and every event kept. Plain JavaScript because the `.mjs` smokes run under bare `node`; the types the
 * `.mts` ones read are in `host-client.d.mts`.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url))

/**
 * Starts a host and resolves with it once it prints its handshake. `db` names the store file; without it the store is
 * in memory. The host's environment is this process's plus `env`: a script that must not touch the real data folder
 * sets `CC_DATA_DIR` there.
 */
export function startHost({ db, env } = {}) {
  const token = randomBytes(16).toString('hex')
  const host = spawn(process.execPath, ['--import', 'tsx', MAIN, '--port', '0', '--token', token, ...(db ? ['--db', db] : ['--memory'])], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (host.kill(), reject(new Error('host startup timeout'))), 60_000)
    host.on('exit', (code) => (clearTimeout(timer), reject(new Error(`host exited before ready (${code})`))))
    host.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        try {
          const j = JSON.parse(line)
          if (j.ready) (clearTimeout(timer), resolve({ host, port: j.port, token }))
        } catch {
          /* a log line */
        }
      }
    })
  })
}

/**
 * Connects to a started host and resolves with the client once the host has greeted. `call` rejects after `timeoutMs`;
 * `onEvent` sees every event as it arrives.
 */
export function connect({ port, token }, { timeoutMs = 240_000, onEvent } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const pending = new Map()
  const events = []
  const waiters = []
  let id = 0
  const client = {
    ws,
    events,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const rid = String(++id)
        const timer = setTimeout(() => (pending.delete(rid), reject(new Error(`${method} timeout`))), timeoutMs)
        pending.set(rid, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) })
        ws.send(JSON.stringify({ kind: 'rpc', id: rid, method, params }))
      }),
    /** The first event of the log from index `from` that `pred` accepts, seen already or arriving; rejects after `ms` */
    next: (pred, what, ms = 240_000, from = 0) =>
      new Promise((resolve, reject) => {
        const seen = events.slice(from).find(pred)
        if (seen) return resolve(seen)
        const timer = setTimeout(() => reject(new Error(`no ${what} in ${ms} ms`)), ms)
        waiters.push({ pred, resolve: (e) => (clearTimeout(timer), resolve(e)) })
      }),
    /** Sends a message and waits for the session's turn to end (or `ms`); returns that session's events of the turn */
    async turn(sessionId, text, ms = 180_000) {
      const from = events.length
      await client.call('agents.send', { sessionId, text })
      await client.next((e) => e.sessionId === sessionId && e.type === 'turn_complete', 'turn end', ms, from).catch(() => {})
      return events.slice(from).filter((e) => e.sessionId === sessionId)
    },
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no hello_ok')), 10_000)
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: 1 })))
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.kind === 'hello_ok') (clearTimeout(timer), resolve(client))
      else if (m.kind === 'res') {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error?.message ?? 'rpc failure'))
      } else if (m.kind === 'event') {
        events.push(m.event)
        for (const w of [...waiters]) if (w.pred(m.event)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m.event))
        onEvent?.(m.event)
      }
    })
  })
}

/**
 * Removes a smoke's temp folder once its host is stopped. On Windows an agent process the host started can hold the folder
 * after the host itself is gone, so a busy folder is retried for about 14 s (Node waits a little longer before each retry) and then left, said so: a folder left behind
 * must not turn the checks' verdict into a crash.
 */
export function removeTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 7, retryDelay: 500 })
  } catch (e) {
    console.warn(`temp folder left behind (${e.code}): ${dir}`)
  }
}

/** A host started and connected to: the client, with the host's process as `host` and its `port`, and `stop` to end it; a host that does not greet is stopped */
export async function openHost(opts = {}) {
  const started = await startHost(opts)
  try {
    const client = await connect(started, opts)
    const { host } = started
    return Object.assign(client, {
      host,
      port: started.port,
      /** Closes the connection and ends the host, and waits until it is gone */
      async stop() {
        client.ws.close()
        if (host.exitCode !== null || host.signalCode !== null) return
        const exited = new Promise((r) => host.once('exit', r))
        host.kill()
        await exited
      },
    })
  } catch (e) {
    started.host.kill()
    throw e
  }
}
