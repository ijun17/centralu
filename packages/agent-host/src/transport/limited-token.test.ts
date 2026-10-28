/** The limited credential (#1405): its derivation, and what a connection holding it may do */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { PROTOCOL_VERSION, type NormalizedEvent } from '@cc/protocol'
import { CREDENTIAL_FILE_UNREADABLE, HostServer, type RpcContext } from './server.js'
import { credentialProof, hostProof, proofNonce, provesCredential } from './host-proof.js'
import { LAST_READ_KEPT_MS, readCredentialFile, verifierOf } from '../lifecycle/serve-credentials.js'
import { isLimitedToken, limitedToken } from './limited-token.js'
import { bridgeToken } from './bridge-token.js'
import { HostRequests } from '../host-requests.js'

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

async function hello(port: number, token: string, extra: Record<string, unknown> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, unknown>[] = []
  ws.on('message', (d) => frames.push(JSON.parse(text(d))))
  let reason = ''
  const closed = new Promise<number>((r) => ws.on('close', (code, why) => ((reason = String(why)), r(code))))
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION, ...extra }))
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
  return { ws, frames, closed, wait, call, reason: () => reason }
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

// #1508: an idle update of a linked machine that follows the hub's version runs; the server reads that from the host it was given
describe("a limited machines.update reads the host's state (#1508)", () => {
  it('runs when the host says the machine follows the hub, and is refused as asks otherwise, or by a server given no host state', async () => {
    const follows = new Set(['m1'])
    const calls: Call[] = []
    server = new HostServer({
      port: 0,
      token: TOKEN,
      onRpc: async (method, params, ctx) => {
        calls.push({ method, params, ctx })
        return { ok: true }
      },
      rightsHost: { followsHub: (id) => follows.has(id), updateAtRest: () => false },
    })
    const script = await hello(await server.listen(), limitedToken(TOKEN))
    expect((await script.call('machines.update', { machineId: 'm1' })).ok).toBe(true)
    expect((await script.call('machines.update', { machineId: 'm1', when: 'now' })).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
    expect((await script.call('machines.update', { machineId: 'm2' })).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
    // Automatic updates went off meanwhile: read at the call, not once
    follows.delete('m1')
    expect((await script.call('machines.update', { machineId: 'm1' })).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
    // The transport's verdict reaches the handler, which holds the call to it rather than judging again
    expect(calls.map((c) => [c.method, c.params, c.ctx?.rights, c.ctx?.covered])).toEqual([['machines.update', { machineId: 'm1' }, 'limited', true]])
    await server.close()
    const bare = await start()
    const other = await hello(bare.port, limitedToken(TOKEN))
    expect((await other.call('machines.update', { machineId: 'm1' })).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
  })
})

// #1509: applying an update runs while Automatic updates are on and the host is idle, and the answer is read at each call
describe("a limited updates.apply reads the host's state (#1509)", () => {
  it('runs when the host is at rest, asks otherwise, and tells the handler it went uncarded', async () => {
    let atRest = true
    const calls: Call[] = []
    server = new HostServer({
      port: 0,
      token: TOKEN,
      onRpc: async (method, params, ctx) => {
        calls.push({ method, params, ctx })
        return { ok: true }
      },
      rightsHost: { followsHub: () => false, updateAtRest: () => atRest },
    })
    const script = await hello(await server.listen(), limitedToken(TOKEN))
    expect((await script.call('updates.apply', {})).ok).toBe(true)
    atRest = false
    expect((await script.call('updates.apply', {})).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
    expect(calls.map((c) => [c.method, c.ctx?.rights, c.ctx?.covered])).toEqual([['updates.apply', 'limited', true]])
    await server.close()
    const bare = await start()
    const other = await hello(bare.port, limitedToken(TOKEN))
    expect((await other.call('updates.apply', {})).error?.data).toEqual({ refused: 'rights', rights: 'asks' })
  })
})

describe('a limited call that asks the person, over the sockets (#1405 slice 3)', () => {
  /** A host whose limited `asks` calls go to host requests, with a trash of one session */
  async function startWithRequests() {
    const purged: string[] = []
    const requests: HostRequests = new HostRequests({
      emit: (e) => srv.broadcast(e),
      canShow: () => srv.showsHostRequests(),
      rpc: async (method, params) => {
        if (method === 'trash.list') return { sessions: [{ id: 's1', name: 'Fix the parser', tool: 'claude', project: null, deletedAt: 1, messages: 2, bytes: 10, conversationFile: 'keep' }], runs: [], bytes: 10 }
        if (method === 'trash.purge') purged.push((params as { sessionId: string }).sessionId)
        return { ok: true }
      },
    })
    const srv: HostServer = new HostServer({
      port: 0,
      token: TOKEN,
      onRpc: async (method, params) => {
        if (method === 'requests.list') return requests.list()
        if (method === 'requests.answer') {
          const a = params as { requestId: string; decision: 'allow' | 'deny' }
          return { ok: requests.answer(a.requestId, a.decision) }
        }
        return { ok: true }
      },
      onAsk: (method, params, from, signal) => requests.ask(method, params, from, signal),
    })
    server = srv
    const port = await srv.listen()
    return { srv, port, purged, requests }
  }

  async function windowHello(port: number, shows: string[] | undefined, token = TOKEN) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const frames: Record<string, unknown>[] = []
    ws.on('message', (d) => frames.push(JSON.parse(text(d))))
    await new Promise<void>((r) => ws.on('open', () => r()))
    ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION, ...(shows ? { shows } : {}) }))
    const wait = async (pred: () => boolean, ms = 3000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error('timeout')
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    await wait(() => frames.some((f) => f.kind === 'hello_ok'))
    return { ws, frames, wait }
  }

  /** Sends one call and returns its answer whenever it comes */
  function send(c: { ws: WebSocket; frames: Record<string, unknown>[] }, id: string, method: string, params: unknown) {
    c.ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    return async (wait: (pred: () => boolean, ms?: number) => Promise<void>) => {
      await wait(() => c.frames.some((f) => f.kind === 'res' && f.id === id))
      return c.frames.find((f) => f.kind === 'res' && f.id === id) as { ok: boolean; result?: unknown; error?: { message: string; data?: { refused?: string } } }
    }
  }

  it('is refused at once while no window that shows host requests holds the token: a window from before, or a hub, does not count', async () => {
    const { port, purged } = await startWithRequests()
    await windowHello(port, undefined)
    const script = await hello(port, limitedToken(TOKEN))
    const res = await script.call('trash.purge', { sessionId: 's1' })
    expect(res.ok).toBe(false)
    expect(res.error?.data).toEqual({ refused: 'no_window' })
    expect(purged).toEqual([])
  })

  it('waits for the window: the card reaches it, its Allow runs the call, and the program gets the answer', async () => {
    const { port, purged } = await startWithRequests()
    const win = await windowHello(port, ['host_requests'])
    const script = await hello(port, limitedToken(TOKEN), { client: '  host-rpc \u202e script that names itself at length, past what a card shows of it  ' })
    const answer = send(script, 'p', 'trash.purge', { sessionId: 's1' })
    await win.wait(() => win.frames.some((f) => f.kind === 'event' && (f.event as NormalizedEvent).type === 'host_request'))
    const raised = win.frames.find((f) => f.kind === 'event' && (f.event as NormalizedEvent).type === 'host_request')!.event as { request: { requestId: string; question: string; client: string | null } }
    expect(raised.request.question).toContain('"Fix the parser"')
    // What the program called itself, trimmed, cut to 60 characters and quoted with its format characters escaped
    expect(raised.request.client).toBe('"host-rpc \\u202e script that names itself at length, past what a c"')
    // The program cannot answer its own card
    const self = await script.call('requests.answer', { requestId: raised.request.requestId, decision: 'allow' })
    expect(self.error?.data).toEqual({ refused: 'rights', rights: 'window' })
    expect(purged).toEqual([])
    win.ws.send(JSON.stringify({ kind: 'rpc', id: 'a', method: 'requests.answer', params: { requestId: raised.request.requestId, decision: 'allow' } }))
    expect(await answer(script.wait)).toMatchObject({ ok: true, result: { ok: true } })
    expect(purged).toEqual(['s1'])
  })

  it('is withdrawn when the program disconnects: the window hears it, and nothing runs', async () => {
    const { port, purged, requests } = await startWithRequests()
    const win = await windowHello(port, ['host_requests'])
    const script = await hello(port, limitedToken(TOKEN))
    send(script, 'p', 'trash.purge', { sessionId: 's1' })
    await win.wait(() => requests.list().length === 1)
    script.ws.close()
    await win.wait(() => win.frames.some((f) => f.kind === 'event' && (f.event as { type: string; outcome?: string }).outcome === 'withdrawn'))
    expect(requests.list()).toEqual([])
    expect(purged).toEqual([])
  })

  it('stops counting a window once it is gone', async () => {
    const { srv, port } = await startWithRequests()
    const win = await windowHello(port, ['host_requests'])
    expect(srv.showsHostRequests()).toBe(true)
    win.ws.close()
    await win.wait(() => !srv.showsHostRequests())
    // The limited credential saying it shows them counts for nothing: it cannot answer
    await windowHello(port, ['host_requests'], limitedToken(TOKEN))
    expect(srv.showsHostRequests()).toBe(false)
  })
})

/*
 * A `centralu serve` host (#1405 slice 5): its key is the token it derives from, and it takes as full only a credential
 * whose verifier serve.json names, read at each hello (lifecycle/serve-credentials.ts)
 */
const SERVE_KEY = 'k'.repeat(43)
const SERVE_HUB = 'h'.repeat(43)
const SERVE_WINDOW = 'w'.repeat(43)
const serveEntry = (id: string, token: string) => ({ id, label: id, verifier: verifierOf(token), created: 1 })

/** A host as `centralu serve` starts one: its key as the token, its full credentials those the file names */
async function serveHost(full: object[], opts: { credentialSweepMs?: number; path?: string; now?: () => number } = {}) {
  // serve.json as the host reads it at each hello; `write` replaces it as the launcher does, `remove` moves it aside, `deny` takes this user's read away
  let file: string | null = ''
  let denied = false
  const write = (entries: object[]) => (file = JSON.stringify({ v: 2, key: SERVE_KEY, port: null, full: entries }))
  const remove = () => (file = null)
  const deny = (on = true) => (denied = on)
  const read = () => {
    if (denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    if (file === null) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    return file
  }
  write(full)
  const path = opts.path ?? 'serve.json'
  server = new HostServer({
    port: 0,
    token: SERVE_KEY,
    fullCredentials: () => readCredentialFile(path, read, () => {}, opts.now),
    ...(opts.credentialSweepMs ? { credentialSweepMs: opts.credentialSweepMs } : {}),
    onRpc: async () => ({ ok: true }),
  })
  const port = await server.listen()
  return { port, write, remove, deny }
}

/** The frames a socket gets for what it sends first (a prove, a hello), and the code it closed with, if it did */
async function serveExchange(port: number, first: object): Promise<{ frames: Record<string, unknown>[]; closed: number | null }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, unknown>[] = []
  let closed: number | null = null
  ws.on('message', (d) => frames.push(JSON.parse(text(d))))
  ws.on('close', (code) => (closed = code))
  await new Promise<void>((r) => ws.on('open', () => r()))
  ws.send(JSON.stringify(first))
  for (let i = 0; i < 200 && frames.length === 0 && closed === null; i++) await new Promise((r) => setTimeout(r, 10))
  ws.close()
  return { frames, closed }
}

const serveHello = (port: number, token: string) => serveExchange(port, { kind: 'hello', token, protocolVersion: PROTOCOL_VERSION })

describe('a centralu serve host takes as full only the credentials serve.json names (#1405)', () => {
  it('lets a paired credential in, not the key it was handed, and the limited credential as a client', async () => {
    const { port } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB)])
    expect((await serveHello(port, SERVE_HUB)).frames[0]).toMatchObject({ kind: 'hello_ok' })
    expect((await serveHello(port, SERVE_KEY)).closed).toBe(4001)
    expect((await serveHello(port, limitedToken(SERVE_KEY))).frames[0]).toMatchObject({ kind: 'hello_ok' })
  })

  it('keeps out an entry written by hand that nothing would list: no label, or an id --revoke does not take', async () => {
    const { port, write } = await serveHost([{ id: 'aaaaaaaa', verifier: verifierOf(SERVE_HUB), created: 1 }])
    expect((await serveHello(port, SERVE_HUB)).closed).toBe(4001)
    write([{ id: 'zz', label: 'hand', verifier: verifierOf(SERVE_HUB), created: 1 }])
    expect((await serveHello(port, SERVE_HUB)).closed).toBe(4001)
    write([serveEntry('aaaaaaaa', SERVE_HUB)])
    expect((await serveHello(port, SERVE_HUB)).frames[0]).toMatchObject({ kind: 'hello_ok' })
  })

  it('reads the file at each hello: a pairing lets the next one in, a revocation keeps it out', async () => {
    const { port, write } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB)])
    expect((await serveHello(port, SERVE_WINDOW)).closed).toBe(4001)
    write([serveEntry('aaaaaaaa', SERVE_HUB), serveEntry('bbbbbbbb', SERVE_WINDOW)])
    expect((await serveHello(port, SERVE_WINDOW)).frames[0]).toMatchObject({ kind: 'hello_ok' })
    write([serveEntry('bbbbbbbb', SERVE_WINDOW)])
    expect((await serveHello(port, SERVE_HUB)).closed).toBe(4001)
  })

  it("proves under the named credential's verifier, which only its holder can check, and under the key otherwise", async () => {
    const { port } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB)])
    const nonce = proofNonce()
    const named = (await serveExchange(port, { kind: 'prove', nonce, credential: 'aaaaaaaa' })).frames[0] as { mac: string }
    expect(named.mac).toBe(credentialProof(verifierOf(SERVE_HUB), nonce))
    expect(provesCredential(verifierOf(SERVE_HUB), nonce, named.mac)).toBe(true)
    expect(provesCredential(verifierOf(SERVE_WINDOW), nonce, named.mac)).toBe(false)
    // No credential named, or one it does not hold: the proof the launcher's own probe checks, under the key
    const plain = (await serveExchange(port, { kind: 'prove', nonce })).frames[0] as { mac: string }
    expect(plain.mac).toBe(hostProof(SERVE_KEY, nonce))
    const unknown = (await serveExchange(port, { kind: 'prove', nonce, credential: 'cccccccc' })).frames[0] as { mac: string }
    expect(unknown.mac).toBe(hostProof(SERVE_KEY, nonce))
  })

  /*
   * #1405 review, the blocker: `--pair x`, a socket opened with it, `--revoke` within 135 ms. The socket kept full
   * rights for as long as it stayed open (75 s+ measured), while serve.json, and so every listing, no longer named it
   */
  it('closes a socket already in with a credential once it is revoked, and leaves the others', async () => {
    const { port, write } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB), serveEntry('bbbbbbbb', SERVE_WINDOW)], { credentialSweepMs: 20, path: 'revoked.json' })
    const hub = await hello(port, SERVE_HUB)
    const win = await hello(port, SERVE_WINDOW)
    const limited = await hello(port, limitedToken(SERVE_KEY))
    await hub.wait(() => [hub, win, limited].every((c) => c.frames.some((f) => f.kind === 'hello_ok')))
    write([serveEntry('bbbbbbbb', SERVE_WINDOW)])
    expect(await hub.closed).toBe(4001)
    // The window's credential is still listed, and the limited one was never full: both stay in
    await new Promise((r) => setTimeout(r, 100))
    expect((await win.call('x')).ok).toBe(true)
    expect(limited.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('closes it at the next hello too, before any sweep', async () => {
    const { port, write } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB), serveEntry('bbbbbbbb', SERVE_WINDOW)], { credentialSweepMs: 3_600_000, path: 'hello.json' })
    const hub = await hello(port, SERVE_HUB)
    await hub.wait(() => hub.frames.some((f) => f.kind === 'hello_ok'))
    write([serveEntry('bbbbbbbb', SERVE_WINDOW)])
    expect((await serveHello(port, SERVE_WINDOW)).frames[0]).toMatchObject({ kind: 'hello_ok' })
    expect(await hub.closed).toBe(4001)
  })

  it('closes every full socket when serve.json is moved aside (#1405 review)', async () => {
    const { port, remove } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB)], { credentialSweepMs: 20, path: 'moved.json' })
    const hub = await hello(port, SERVE_HUB)
    await hub.wait(() => hub.frames.some((f) => f.kind === 'hello_ok'))
    remove()
    expect(await hub.closed).toBe(4001)
    expect((await serveHello(port, SERVE_HUB)).closed).toBe(4001)
  })

  /*
   * #1405 review: serve.json made unreadable (chmod 000). A credential paired just before kept full rights 30 s while
   * no row listed it, and then every full socket, the hub's too, closed as "credential withdrawn", which the hub took
   * for its own credential taken over
   */
  it('refuses a new full hello at once while serve.json cannot be read, and closes the open ones after a few seconds as unreadable, not withdrawn', async () => {
    let t = 1_000_000
    const { port, write, deny } = await serveHost([serveEntry('aaaaaaaa', SERVE_HUB)], { credentialSweepMs: 20, path: 'denied.json', now: () => t })
    const hub = await hello(port, SERVE_HUB)
    await hub.wait(() => hub.frames.some((f) => f.kind === 'hello_ok'))
    write([serveEntry('aaaaaaaa', SERVE_HUB), serveEntry('bbbbbbbb', SERVE_WINDOW)])
    // The host reads the new pairing (its sweep, every 20 ms here) before the file goes unreadable
    await new Promise((r) => setTimeout(r, 100))
    deny()
    // The one paired just before the file went unreadable: refused at its first hello, and said why
    const fresh = await hello(port, SERVE_WINDOW)
    expect(await fresh.closed).toBe(4001)
    expect(fresh.reason()).toBe(CREDENTIAL_FILE_UNREADABLE)
    // The socket already in stays for a few seconds of a busy file, and the limited credential was never full
    await new Promise((r) => setTimeout(r, 100))
    expect(hub.ws.readyState).toBe(WebSocket.OPEN)
    expect((await serveHello(port, limitedToken(SERVE_KEY))).frames[0]).toMatchObject({ kind: 'hello_ok' })
    t += LAST_READ_KEPT_MS + 1
    expect(await hub.closed).toBe(4001)
    expect(hub.reason()).toBe(CREDENTIAL_FILE_UNREADABLE)
    // Readable again: the credentials it names work as before
    deny(false)
    expect((await serveHello(port, SERVE_WINDOW)).frames[0]).toMatchObject({ kind: 'hello_ok' })
  })
})

