#!/usr/bin/env node
/**
 * The Codex <-> Centralu bridge (an stdio MCP server).
 *
 * Codex can only attach an **stdio server** through per-thread config — measured, the HTTP (url)
 * approach never received a single request (codex-cli 0.147.0). So one extra process ends up
 * attached. Claude does not need this file, since it is in-process.
 *
 * **This bridge makes no decisions.** It only passes a tool name and arguments to the host and
 * relays back whatever text it receives. Access scope, listing rules and presentation all stay on
 * the host — copying even a little of that logic here would let the two adapters' tools drift apart.
 *
 * codex launches this file directly with `node <path>`, so it **must stay a plain .mjs file**
 * (it goes through neither tsx nor a bundler).
 *
 * What it receives through environment variables:
 *   CC_HOST_URL       the host's WS address
 *   CC_HOST_TOKEN     the auth token
 *   CC_SESSION_ID     this session's id (the host judges permission by this)
 *   CC_APP_SERVER     (if present) this is the bridge for a single external app — that app's session server name `app-<id>` (M4 A-5)
 *
 * **Why there is one bridge, not two.** The orchestrator tools and an external app take the same
 * path back to the host (the WS address, token and session id). Splitting this into two files
 * would double the bundle copy, path lookup and reconnection logic. Only two RPCs called differ:
 * for an app it is `apps.sessionTools`/`apps.sessionCall`, otherwise `orchestrator.tools`/
 * `orchestrator.tool`. The app bridge also makes no decisions — decision 4 (which apps attach),
 * exposure scope, and logging are all re-checked by the host using the session id.
 */
import { WebSocket } from 'ws'

const URL_ = process.env.CC_HOST_URL
const TOKEN = process.env.CC_HOST_TOKEN
const SESSION_ID = process.env.CC_SESSION_ID
const APP_SERVER = process.env.CC_APP_SERVER || null
/**
 * An app call that takes longer than this gets a run id and "still running" back from the host
 * first (M4 A-5, "long-running calls"). The value is decided by the adapter alongside Codex's own
 * ceiling and passed down — the bridge only carries it through.
 */
const APP_WAIT_MS = Number(process.env.CC_APP_WAIT_MS) || undefined

/**
 * The ceiling for waiting on a single app tool call. It must be shorter than Codex's own ceiling
 * (`tool_timeout_sec`, 300 seconds — set explicitly by the adapter) so the bridge is the one that
 * states the reason first. If the bridge cuts it off first, the model reads "the bridge gave up
 * waiting"; if Codex cuts it off first, all that is left is a timeout with no reason. It must also
 * be longer than the point where the host returns early (APP_WAIT_MS) — otherwise "still running"
 * cannot make it past the bridge to the model.
 */
const APP_CALL_TIMEOUT_MS = 280_000

/** stdout is reserved for MCP — every diagnostic goes to stderr instead (mixing them breaks the protocol) */
const log = (...a) => process.stderr.write(`[cc-bridge] ${a.join(' ')}\n`)

let ws = null
let nextId = 1
const pending = new Map()

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(URL_)
    const fail = (e) => reject(e instanceof Error ? e : new Error(String(e)))
    sock.on('error', fail)
    sock.on('message', (raw) => {
      let f
      try {
        f = JSON.parse(String(raw))
      } catch {
        return
      }
      if (f.kind === 'res') {
        const p = pending.get(f.id)
        if (!p) return
        pending.delete(f.id)
        if (f.ok) p.resolve(f.result)
        else p.reject(new Error(f.error?.message ?? 'host error'))
      }
    })
    sock.on('open', () => {
      sock.send(JSON.stringify({ kind: 'hello', token: TOKEN, protocolVersion: 1 }))
      ws = sock
      resolve(sock)
    })
  })
}

async function rpc(method, params, timeoutMs = 60000) {
  if (!ws || ws.readyState !== 1) await connect()
  const id = String(nextId++)
  ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`))
    }, timeoutMs)
  })
}

// ── MCP (stdio, JSON-RPC 2.0) ────────────────────────────────────────
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const err = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } })

async function handle(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: APP_SERVER ?? 'centralu', version: '1' },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return ok(id, {})

  if (APP_SERVER) return handleApp(id, method, params)

  if (method === 'tools/list') {
    try {
      // Sends its own session id along — a manager session (#69) must only receive the subset
      const tools = await rpc('orchestrator.tools', { sessionId: SESSION_ID })
      return ok(id, { tools })
    } catch (e) {
      return err(id, `Could not get the tool list — ${e.message}`)
    }
  }

  if (method === 'tools/call') {
    try {
      const r = await rpc('orchestrator.tool', {
        sessionId: SESSION_ID,
        name: params?.name,
        args: params?.arguments ?? {},
      })
      return ok(id, { content: [{ type: 'text', text: r.text }], isError: r.isError === true })
    } catch (e) {
      // Does not silently pretend it succeeded — pretending the model's request went through leaves only the person unaware
      return ok(id, { content: [{ type: 'text', text: `Could not run the tool — ${e.message}` }], isError: true })
    }
  }

  if (id !== undefined) err(id, `Unsupported method: ${method}`)
}

/**
 * The bridge for a single external app (M4 A-5). The tool list and results are surfaced exactly
 * in the MCP shape the host gave — trimming the description, annotations or schema here would let
 * the tool Codex sees drift apart from the one Claude sees.
 */
async function handleApp(id, method, params) {
  if (method === 'tools/list') {
    try {
      const r = await rpc('apps.sessionTools', { sessionId: SESSION_ID, server: APP_SERVER })
      return ok(id, { tools: r.tools })
    } catch (e) {
      return err(id, `Could not get the app's tool list — ${e.message}`)
    }
  }
  if (method === 'tools/call') {
    try {
      const r = await rpc(
        'apps.sessionCall',
        { sessionId: SESSION_ID, server: APP_SERVER, name: params?.name, args: params?.arguments ?? {}, ...(APP_WAIT_MS ? { waitMs: APP_WAIT_MS } : {}) },
        APP_CALL_TIMEOUT_MS,
      )
      return ok(id, r)
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `Could not run the app's tool — ${e.message}` }], isError: true })
    }
  }
  // There is nothing to answer for a notification (notifications/cancelled, etc.) — stopping a session lets the host cut off that session's app calls directly
  if (id !== undefined) err(id, `Unsupported method: ${method}`)
}

if (!URL_ || !TOKEN || !SESSION_ID) {
  log('CC_HOST_URL, CC_HOST_TOKEN, and CC_SESSION_ID are required')
  process.exit(1)
}

let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  for (;;) {
    const nl = buf.indexOf('\n')
    if (nl < 0) break
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg).catch((e) => log('Failed to process:', e.message))
  }
})
process.stdin.on('end', () => process.exit(0))
