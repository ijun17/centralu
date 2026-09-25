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
 * Shutdown contract (S-5): the socket is `unref`ed, so the pipe alone never keeps the app alive,
 * and it is closed when stdin ends, which is Centralu's "stop now" signal.
 */
import net from 'node:net'

export const RUN_META = 'centralu/runId'
const PROTOCOL_VERSION = '2025-11-25'

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
    for (const p of pending.values()) p.reject(new BrokerError(why))
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
      if (msg.id === undefined || !pending.has(msg.id)) continue
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new BrokerError(`Centralu refused ${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else p.resolve(msg.result)
    }
  })
  sock.on('error', (e) => failAll(`Centralu's broker pipe failed: ${e.message}`))
  sock.on('close', () => failAll("Centralu's broker pipe closed"))
  process.stdin.once('end', () => sock.destroy())

  const send = (msg) => sock.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  const request = (method, params, signal) =>
    new Promise((resolve, reject) => {
      if (closedWith) return reject(new BrokerError(closedWith))
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      send({ id, method, params })
      if (signal) {
        const onAbort = () => {
          if (!pending.delete(id)) return
          send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'the tool call that asked was cancelled' } })
          reject(new BrokerError(`${method} was cancelled`))
        }
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
 * BrokerError whose message says what Centralu answered.
 */
export async function callBroker(tool, args, runId, signal) {
  const c = open()
  await c.ready
  return c.request('tools/call', { name: tool, arguments: args, _meta: { [RUN_META]: runId } }, signal)
}
