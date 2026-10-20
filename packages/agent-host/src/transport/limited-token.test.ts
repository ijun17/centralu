/** The limited credential (#1405): its derivation, and what a connection holding it may do */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { PROTOCOL_VERSION, type NormalizedEvent } from '@cc/protocol'
import { HostServer, type RpcContext } from './server.js'
import { isLimitedToken, limitedToken } from './limited-token.js'
import { bridgeToken } from './bridge-token.js'

describe('the limited credential is derived from the token', () => {
  it('matches the vector the keeper is checked against (#1405 slice 4)', () => {
    // A keeper token is 32 hex characters (front_door.rs); the keeper's Rust derivation must give the same
    expect(limitedToken('0123456789abcdef0123456789abcdef')).toBe('ccl1:GCq4ylEN4gVq4i5lDTQIGSQHYNP_K-4C2FBfWGM0JAc')
    expect(limitedToken('test-token')).toBe('ccl1:bRS_kvn-WzK4GDYf6ToAgbG5AzPQaLMW5Y7NtD5nhdM')
  })

  it("is only its own token's: not another token's, not a bridge credential, not the token itself", () => {
    expect(isLimitedToken('a', limitedToken('a'))).toBe(true)
    expect(isLimitedToken('a', limitedToken('b'))).toBe(false)
    expect(isLimitedToken('a', bridgeToken('a', 's1'))).toBe(false)
    expect(isLimitedToken('a', 'a')).toBe(false)
    expect(isLimitedToken('a', `${limitedToken('a')}x`)).toBe(false)
    expect(limitedToken('a')).not.toContain('a:')
  })
})

const TOKEN = 'test-token'
let server: HostServer | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

type Call = { method: string; params: unknown; ctx: RpcContext | undefined }

async function start() {
  const calls: Call[] = []
  server = new HostServer({
    port: 0,
    token: TOKEN,
    onRpc: async (method, params, ctx) => {
      calls.push({ method, params, ctx })
      return { ok: true }
    },
  })
  const port = await server.listen()
  return { srv: server, port, calls }
}

/** A frame's text, whichever form the library hands it in */
const text = (d: RawData) => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d)).toString('utf8')

async function hello(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, unknown>[] = []
  ws.on('message', (d) => frames.push(JSON.parse(text(d))))
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION }))
  const wait = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  let n = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = `c${++n}`
    ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    await wait(() => frames.some((f) => f.kind === 'res' && f.id === id))
    return frames.find((f) => f.kind === 'res' && f.id === id) as { ok: boolean; error?: { code: string; message: string; data?: unknown } }
  }
  return { ws, frames, closed, wait, call }
}

const ev = (sessionId: string): NormalizedEvent => ({ type: 'turn_started', sessionId, turnId: 't1' }) as unknown as NormalizedEvent

/**
 * What the owner's orchestration sends over the credential `keeper.sock` `status` hands out (#1405, owner
 * 2026-10-21): these stay everyday
 */
const ORCHESTRATION: [string, unknown][] = [
  ['agents.createSession', { projectId: 'p1', cwd: 'C:/work/p1', tool: 'claude' }],
  ['agents.send', { sessionId: 's1', text: 'hi' }],
  ['sessions.rename', { sessionId: 's1', name: 'n' }],
  ['sessions.list', {}],
  ['agents.listExternalSessions', { projectId: 'p1', tool: 'claude' }],
  ['agents.setSleepPolicy', { policy: { idleMinutes: 30 } }],
  ['trash.list', {}],
]

/** What cannot be undone, the person's own answers, the hub's calls and the bridge's channel */
const REFUSED: [string, unknown, string][] = [
  ['trash.purge', { sessionId: 'm1.s1' }, 'asks'],
  ['trash.empty', {}, 'asks'],
  ['trash.purgeRuns', { runIds: ['r1'] }, 'asks'],
  ['trash.purgeSubagentSteps', { sessionId: 's1' }, 'asks'],
  ['agents.deleteSession', { sessionId: 's1' }, 'asks'],
  ['projects.setTrusted', { projectId: 'p1', trusted: true }, 'asks'],
  ['agents.createSession', { projectId: 'p1', tool: 'claude', permissionPreset: 'auto' }, 'asks'],
  ['agents.updateSettings', { sessionId: 's1', permissionPreset: 'auto' }, 'asks'],
  // A hub's session carries its preset: an auto one would start this session under auto (#1405 review)
  ['agents.createSession', { projectId: 'p1', tool: 'claude', fromHub: { callerPreset: 'auto' } }, 'asks'],
  ['updates.reportApply', { requestId: 'r', ticket: 't', state: 'failed' }, 'window'],
  ['agents.respondApproval', { sessionId: 's1', requestId: 'r', decision: 'allow' }, 'window'],
  ['workspace.save', {}, 'window'],
  ['host.send', { sessionId: 's1', text: 'x' }, 'link'],
  ['host.hubOffer', { hub: { id: 'h', name: 'h' }, on: true }, 'link'],
  ['orchestrator.tool', { sessionId: 's1', name: 'empty_trash', args: {} }, 'bridge'],
  ['no.such.method', {}, 'unknown'],
]

describe('a connection holding the limited credential (#1405)', () => {
  it("is accepted at hello and runs the owner's orchestration calls, which the handler sees as limited", async () => {
    const { port, calls } = await start()
    const c = await hello(port, limitedToken(TOKEN))
    await c.wait(() => c.frames.some((f) => f.kind === 'hello_ok'))
    for (const [method, params] of ORCHESTRATION) expect(await c.call(method, params)).toMatchObject({ ok: true })
    expect(calls.map((x) => x.method)).toEqual(ORCHESTRATION.map(([m]) => m))
    expect(calls.every((x) => x.ctx?.rights === 'limited')).toBe(true)
    c.ws.close()
  })

  it('is refused every call that cannot be undone or is not its own, before the handler (and so before any relay to a linked machine)', async () => {
    const { port, calls } = await start()
    const c = await hello(port, limitedToken(TOKEN))
    for (const [method, params, rights] of REFUSED) {
      const res = await c.call(method, params)
      expect(res.ok, method).toBe(false)
      expect(res.error?.data, method).toEqual({ refused: 'rights', rights })
      expect(res.error?.code).toBe('internal')
    }
    expect(calls).toEqual([])
    // Still connected: a refusal is an answer, not a cut
    expect(await c.call('sessions.list')).toMatchObject({ ok: true })
    c.ws.close()
  })

  it('changes nothing for the token: the same calls reach the handler as full', async () => {
    const { port, calls } = await start()
    const c = await hello(port, TOKEN)
    for (const [method, params] of REFUSED) expect(await c.call(method, params), method).toMatchObject({ ok: true })
    expect(calls.map((x) => x.method)).toEqual(REFUSED.map(([m]) => m))
    expect(calls.every((x) => x.ctx?.rights === 'full')).toBe(true)
    c.ws.close()
  })

  it('gets the replay and the broadcast like a window: it is a client, unlike a bridge', async () => {
    const { srv, port } = await start()
    srv.broadcast(ev('before'))
    const c = await hello(port, limitedToken(TOKEN))
    await c.wait(() => c.frames.some((f) => f.kind === 'event'))
    srv.broadcast(ev('after'))
    await c.wait(() => c.frames.filter((f) => f.kind === 'event').length === 2)
    c.ws.close()
  })

  it("does not answer the host's own calls: the reverse direction is a hub's, which holds the token", async () => {
    const { srv, port, calls } = await start()
    const c = await hello(port, limitedToken(TOKEN))
    await c.call('sessions.list')
    const client = calls[0]!.ctx!.client
    // The expectation is attached before anything waits, so the timeout's rejection is never unobserved
    const pending = expect(srv.call(client, 'hub.projects', {}, { timeoutMs: 1500 })).rejects.toThrow(/did not answer/)
    await c.wait(() => c.frames.some((f) => f.kind === 'rpc'))
    const asked = c.frames.find((f) => f.kind === 'rpc') as { id: string }
    // Neither an answer nor one in a form the host does not read (which would end the call with that complaint)
    c.ws.send(JSON.stringify({ kind: 'res', id: asked.id, ok: true, result: { projects: [] } }))
    c.ws.send(JSON.stringify({ kind: 'res', id: asked.id, ok: 'not a boolean' }))
    await pending
    c.ws.close()
  })

  it('a credential derived from another token is refused at hello', async () => {
    const { port } = await start()
    const c = await hello(port, limitedToken('another-token'))
    expect(await c.closed).toBe(4001)
  })
})
