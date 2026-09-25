/**
 * The app's side of the Centralu broker pipe (fd 3).
 *
 * Centralu starts every app with one extra pipe next to stdin/stdout/stderr. On that pipe Centralu
 * is an MCP server and the app is its client: this is how an app asks for things outside itself
 * (run an agent, call another app). Only the process that holds the pipe can call, so there is no
 * token. What the call is *for* travels as the run id of the tool call being handled.
 *
 * This is a small hand-written JSON-RPC client instead of the SDK's `Client`: the SDK client brings
 * HTTP and OAuth code the pipe never uses (about 280 KiB of the vendored runtime, measured in the
 * S-6 spike). It speaks the 2025-11-25 handshake, which Centralu's broker accepts.
 *
 * Waiting. An agent run takes minutes and a permission question waits for the person (up to 5
 * minutes), so a broker call has no fixed deadline. Instead every request carries a progress token,
 * and Centralu sends a progress notification every 10 seconds while it works. A request fails only
 * if Centralu says nothing for IDLE_MS (the pipe or the host is gone), or if it runs past
 * MAX_TOTAL_MS in all. Each progress notification is also handed to the caller, which passes it up
 * to whoever called this app (`centralu.mjs`), so that call does not time out either.
 *
 * Shutdown contract (S-5): the socket is `unref`ed, so the pipe alone never keeps the app alive,
 * and it is closed when stdin ends, which is Centralu's "stop now" signal.
 */
import net from 'node:net'

export const RUN_META = 'centralu/runId'
const PROTOCOL_VERSION = '2025-11-25'

/**
 * Six missed 10-second beats: Centralu is not just busy, it is gone. Centralu's own tests shorten it
 * through CENTRALU_BROKER_IDLE_MS; Centralu never passes CENTRALU_* variables on to an app.
 */
export const IDLE_MS = Number(process.env.CENTRALU_BROKER_IDLE_MS) || 60_000
/** One broker call may take an hour at most — longer than any agent run meant for one tool call */
export const MAX_TOTAL_MS = 60 * 60_000

export class BrokerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CentraluError'
  }
}

let conn = null

function open() {
  if (conn) return conn
  let sock
  try {
    sock = new net.Socket({ fd: 3, readable: true, writable: true })
  } catch (e) {
    throw new BrokerError(
      `Centralu's broker pipe (fd 3) is not open, so this app cannot ask Centralu for anything. ` +
        `This happens when server.mjs runs outside Centralu (for example by hand). (${e.message})`,
    )
  }
  sock.unref()
  const pending = new Map()
  let nextId = 1
  let buf = ''
  let closedWith = null
  const failAll = (why) => {
    closedWith = why
    for (const p of pending.values()) p.fail(new BrokerError(why))
    pending.clear()
  }
  sock.setEncoding('utf8')
  sock.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method === 'notifications/progress') {
        pending.get(msg.params?.progressToken)?.progress(msg.params?.message)
        continue
      }
      if (msg.id === undefined || !pending.has(msg.id)) continue
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      p.settle()
      if (msg.error) p.reject(new BrokerError(`Centralu refused ${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
    }
  })
  sock.on('error', (e) => failAll(`Centralu's broker pipe failed: ${e.message}`))
  sock.on('close', () => failAll("Centralu's broker pipe closed"))
  process.stdin.once('end', () => sock.destroy())

  const send = (msg) => sock.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  const request = (method, params, { signal, onProgress } = {}) =>
    new Promise((resolve, reject) => {
      if (closedWith) return reject(new BrokerError(closedWith))
      const id = nextId++
      const started = Date.now()
      // what the person reads when this fails: the broker tool's name, not the JSON-RPC method
      const what = method === 'tools/call' && typeof params?.name === 'string' ? params.name : method
      let idle = null
      let total = null
      const cleanup = () => {
        clearTimeout(idle)
        clearTimeout(total)
        signal?.removeEventListener('abort', onAbort)
      }
      const giveUp = (why) => {
        if (!pending.delete(id)) return
        cleanup()
        send({ method: 'notifications/cancelled', params: { requestId: id, reason: why } })
        reject(new BrokerError(why))
      }
      const armIdle = () => {
        clearTimeout(idle)
        idle = setTimeout(() => giveUp(`Centralu said nothing about ${what} for ${IDLE_MS / 1000}s`), IDLE_MS)
        idle.unref?.()
      }
      const onAbort = () => giveUp(`${what} was cancelled because the tool call that asked was cancelled`)
      pending.set(id, {
        method: what,
        resolve,
        reject,
        settle: cleanup,
        fail: (err) => {
          cleanup()
          reject(err)
        },
        progress: (message) => {
          armIdle()
          onProgress?.(message)
        },
      })
      armIdle()
      total = setTimeout(() => giveUp(`${what} ran past ${MAX_TOTAL_MS / 60_000} minutes (started ${new Date(started).toISOString()})`), MAX_TOTAL_MS)
      total.unref?.()
      const withToken = params && typeof params === 'object' ? { ...params, _meta: { ...params._meta, progressToken: id } } : params
      send({ id, method, params: withToken })
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })

  const ready = (async () => {
    await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: process.env.CENTRALU_APP_ID ?? 'centralu-app', version: '1' },
    })
    send({ method: 'notifications/initialized' })
  })()
  conn = { request, ready }
  return conn
}

/**
 * Calls one broker tool on behalf of the run `runId`. Resolves with the MCP tool result, or throws a
 * BrokerError whose message says what Centralu answered. `onProgress(message?)` is called for each
 * progress notification Centralu sends while it works.
 */
export async function callBroker(tool, args, runId, signal, onProgress) {
  const c = open()
  await c.ready
  return c.request('tools/call', { name: tool, arguments: args, _meta: { [RUN_META]: runId } }, { signal, onProgress })
}
