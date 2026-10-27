import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { GATE_ENV, GateRequests, type GateAnswer, type GateChannel, type GateHandler, type GateRequest } from '../adapters/core/gate.js'
import { SessionProcess } from '../adapters/core/tool-process.js'
import { gateAnswer } from '../adapters/agy/gate-answer.mjs'
import { gateAddress } from '../swap-control.js'
import { FrontDoorGates, gateRefusal, GATE_METHOD, scrub, type FrontDoorGatesOptions } from './gate-door.js'
import { deriveHttpSecret } from './http.js'
import { limitedToken } from './limited-token.js'
import { METHOD_RIGHTS } from './method-rights.js'
import { HostServer } from './server.js'

/**
 * The gate's inbound path (#1654, session-core.md §8.1): the front door's gate route under a gate-only key per session.
 * Driven through a real `HostServer` and, where the hook's side matters, the hook's own `gateAnswer` with Node's `fetch`.
 */

const TOKEN = 'test-token-for-the-gate-door'
const INPUT = { conversationId: 'conv-1', stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } } }

/** A reader in the shape `agy`'s will have: the call's id is its conversation and step */
const read = (input: Readonly<Record<string, unknown>>): GateRequest | null => {
  const call = input.toolCall as { name?: unknown; args?: unknown } | undefined
  if (typeof call?.name !== 'string' || typeof input.stepIdx !== 'number') return null
  return { requestId: `${String(input.conversationId)}:${input.stepIdx}`, tool: call.name, input: call.args, stepIndex: input.stepIdx }
}

const servers: HostServer[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function host(opts: Partial<FrontDoorGatesOptions> = {}) {
  const at: { port?: number } = {}
  const gates = new FrontDoorGates({ url: (id) => gateAddress(undefined, at.port, id), redact: () => [TOKEN, limitedToken(TOKEN)], ...opts })
  const server = new HostServer({ port: 0, token: TOKEN, onRpc: () => Promise.resolve({ ran: true }), http: { secret: deriveHttpSecret(TOKEN), routes: [] }, gate: gates })
  servers.push(server)
  const port = await server.listen()
  at.port = port
  return { gates, server, port }
}

/** A session's gate as an adapter will wire it: every request waits in the session process's `gates` for the card */
function cardGate() {
  const sp = new SessionProcess('agy', () => Promise.resolve(null), {}, null)
  const asked: GateRequest[] = []
  const gate: GateHandler = {
    read,
    decide: (r) => {
      asked.push(r)
      return sp.gates.wait(r.requestId)
    },
  }
  return { sp, asked, gate, card: (id: string, a: GateAnswer) => sp.gates.answer(id, a) }
}

/** The hook's own answer for `input`, with the channel's environment, through Node's `fetch` */
const hook = (env: Readonly<Record<string, string>>, input: unknown = INPUT) =>
  gateAnswer({ env: { ...env, CC_GATE_RETRY_MS: '1' }, input: JSON.stringify(input), fetch: globalThis.fetch })

/** A raw POST, for what the hook does not send */
async function post(url: string, key: string | null, body: string, method = 'POST'): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { method, redirect: 'error', headers: key === null ? {} : { authorization: `Bearer ${key}` }, ...(method === 'POST' ? { body } : {}) })
  return { status: res.status, text: await res.text() }
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(pred()).toBe(true)
}

describe('the gate route on the front door', () => {
  it('names the hook’s environment as the hook reads it, and answers the card’s decision', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    expect(Object.keys(ch.env).sort()).toEqual([GATE_ENV.token, GATE_ENV.url].sort())
    expect(ch.env[GATE_ENV.url]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gate\/s1$/)
    const answer = hook(ch.env)
    await until(() => g.asked.length === 1)
    expect(g.asked[0]).toMatchObject({ requestId: 'conv-1:2', tool: 'run_command', stepIndex: 2 })
    g.card('conv-1:2', { decision: 'allow' })
    expect(await answer).toEqual({ decision: 'allow' })
  })

  it('refuses a wrong key with the front door’s plain 404, and the hook denies', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const wrong = `${ch.env[GATE_ENV.token]!.slice(0, -2)}xx`
    expect(await post(ch.env[GATE_ENV.url]!, wrong, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    expect(await post(ch.env[GATE_ENV.url]!, null, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    expect((await hook({ ...ch.env, [GATE_ENV.token]: wrong })).decision).toBe('deny')
    expect(g.asked).toEqual([])
  })

  it('refuses a key made for another session: A’s key cannot raise a request for B', async () => {
    const { gates } = await host()
    const a = cardGate()
    const b = cardGate()
    const chA = await gates.open('session-a', a.gate)
    const chB = await gates.open('session-b', b.gate)
    expect(await post(chB.env[GATE_ENV.url]!, chA.env[GATE_ENV.token]!, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    expect((await hook({ ...chB.env, [GATE_ENV.token]: chA.env[GATE_ENV.token]! })).decision).toBe('deny')
    expect([a.asked, b.asked]).toEqual([[], []])
    // And the binding as the rights read it
    expect(gateRefusal('session-a', GATE_METHOD, { sessionId: 'session-b', request: INPUT })).toMatch(/another session/)
  })

  it('refuses a key after its session closed, and denies what was still open at the close', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const open = hook(ch.env)
    await until(() => g.asked.length === 1)
    await ch.close()
    expect(await open).toEqual({ decision: 'deny', reason: 'The session is closing.' })
    expect(await post(ch.env[GATE_ENV.url]!, ch.env[GATE_ENV.token]!, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    expect(g.asked).toHaveLength(1)
    expect(gates.size).toBe(0)
  })

  it('refuses a request that carries a decision field, before the session sees it', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    for (const field of ['decision', 'permissionDecision', 'answer']) {
      const res = await post(ch.env[GATE_ENV.url]!, ch.env[GATE_ENV.token]!, JSON.stringify({ ...INPUT, [field]: 'allow' }))
      expect(res.status).toBe(400)
      expect((await hook(ch.env, { ...INPUT, [field]: 'allow' })).decision).toBe('deny')
    }
    // Not an object at all is no request either
    for (const body of ['[]', 'null', '"allow"', 'not json']) expect((await post(ch.env[GATE_ENV.url]!, ch.env[GATE_ENV.token]!, body)).status).toBe(400)
    expect(g.asked).toEqual([])
  })

  it('denies an open request when the turn is stopped, and every request once the session closed', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const open = hook(ch.env)
    await until(() => g.asked.length === 1)
    await g.sp.stop()
    expect(await open).toEqual({ decision: 'deny', reason: 'The turn was stopped.' })
    // The session process closed (its key still open): a request asked after is denied at once, never left waiting
    await g.sp.close()
    expect(await hook(ch.env, { ...INPUT, stepIdx: 3 })).toEqual({ decision: 'deny', reason: 'The session is closing.' })
  })

  it('keeps a card open for six minutes with headers at once and a space well inside fetch’s 300 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const arrivals: number[] = []
    let body = ''
    let headersAt = -1
    const start = Date.now()
    // The hook's own client: Node's fetch, reading the body as it comes
    const done = (async () => {
      const res = await fetch(ch.env[GATE_ENV.url]!, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${ch.env[GATE_ENV.token]!}` }, body: JSON.stringify(INPUT) })
      headersAt = Date.now()
      const decoder = new TextDecoder()
      const reader = res.body!.getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        arrivals.push(Date.now())
        body += decoder.decode(r.value, { stream: true })
      }
      return res.status
    })()
    await until(() => headersAt >= 0)
    expect(headersAt - start).toBe(0)
    // Six minutes of the card being open, a step at a time, each step's bytes delivered before the next
    for (let t = 0; t < 12; t++) {
      const n = arrivals.length
      await vi.advanceTimersByTimeAsync(30_000)
      await until(() => arrivals.length > n)
    }
    g.card('conv-1:2', { decision: 'allow' })
    expect(await done).toBe(200)
    const marks = [headersAt, ...arrivals]
    const longest = Math.max(...marks.slice(1).map((t, i) => t - marks[i]!))
    expect(arrivals.at(-1)! - start).toBeGreaterThanOrEqual(6 * 60_000)
    expect(longest).toBeLessThan(300_000)
    expect(JSON.parse(body)).toEqual({ decision: 'allow' })
  })

  it('never puts the key or another credential in the answer', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const key = ch.env[GATE_ENV.token]!
    const open = post(ch.env[GATE_ENV.url]!, key, JSON.stringify(INPUT))
    await until(() => g.asked.length === 1)
    g.card('conv-1:2', { decision: 'deny', reason: `Declined (key ${key}, token ${TOKEN}, limited ${limitedToken(TOKEN)}, bridge ccb1:s1:abcdef)` })
    const { status, text } = await open
    expect(status).toBe(200)
    expect(text).not.toContain(key)
    expect(text).not.toContain(key.split(':')[1])
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(limitedToken(TOKEN))
    expect(text).not.toMatch(/cc[a-z]\d:/)
    expect(JSON.parse(text)).toEqual({ decision: 'deny', reason: expect.stringContaining('Declined') })
    // Nor does any refusal: each is a fixed word, whatever was sent
    for (const body of ['not json', JSON.stringify({ ...INPUT, decision: key })]) expect((await post(ch.env[GATE_ENV.url]!, key, body)).text).not.toContain(key)
  })

  it('leaves no usable key across a host swap: the next host has none, and the same session gets a new one', async () => {
    const first = await host()
    const g = cardGate()
    const old = await first.gates.open('s1', g.gate)
    const open = hook(old.env)
    await until(() => g.asked.length === 1)
    // The old host goes: what waited is denied, not cut
    await first.server.close()
    expect(await open).toMatchObject({ decision: 'deny' })
    const next = await host()
    const oldAtNext = `http://127.0.0.1:${next.port}/gate/s1`
    expect(await post(oldAtNext, old.env[GATE_ENV.token]!, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    // Not derived from the host's token: the same session on a host with the same token holds another key
    const again = await next.gates.open('s1', cardGate().gate)
    expect(again.env[GATE_ENV.token]).not.toBe(old.env[GATE_ENV.token])
    expect(await post(oldAtNext, old.env[GATE_ENV.token]!, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
  })
})

describe('trying to break the gate with its own key', () => {
  it('cannot answer its own card: no route, method or field of the channel takes an answer', async () => {
    const { gates, port } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const key = ch.env[GATE_ENV.token]!
    const url = ch.env[GATE_ENV.url]!
    const open = hook(ch.env)
    await until(() => g.asked.length === 1)
    // An answer in the body, at another path, with another verb: none of it reaches the card
    expect((await post(url, key, JSON.stringify({ ...INPUT, decision: 'allow' }))).status).toBe(400)
    for (const path of [`${url}/answer`, `${url}/conv-1:2`, `http://127.0.0.1:${port}/gate`, `http://127.0.0.1:${port}/gate/s1/../s1/answer`]) {
      expect(await post(path, key, JSON.stringify({ requestId: 'conv-1:2', decision: 'allow' }))).toEqual({ status: 404, text: 'not found' })
    }
    for (const verb of ['PUT', 'GET', 'DELETE']) expect((await post(url, key, '', verb)).status).toBe(404)
    expect(g.sp.gates.size).toBe(1)
    g.card('conv-1:2', { decision: 'deny', reason: 'The person declined.' })
    expect(await open).toEqual({ decision: 'deny', reason: 'The person declined.' })
  })

  it('a replayed request ends the first wait with deny and never yields two allows', async () => {
    const { gates } = await host()
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const first = hook(ch.env)
    await until(() => g.asked.length === 1)
    const replay = hook(ch.env)
    expect(await first).toEqual({ decision: 'deny', reason: 'The request was asked again.' })
    g.card('conv-1:2', { decision: 'allow' })
    expect(await replay).toEqual({ decision: 'allow' })
    // Replayed after the answer: a new card, not the old allow
    const late = hook(ch.env)
    await until(() => g.asked.length === 3)
    expect(g.card('conv-1:2', { decision: 'deny', reason: 'no' })).toBe(true)
    expect(await late).toEqual({ decision: 'deny', reason: 'no' })
  })

  it('opens no other method: the rights refuse every method but gate.ask, and the WebSocket refuses the key', async () => {
    const { gates, port } = await host()
    const ch = await gates.open('s1', cardGate().gate)
    const key = ch.env[GATE_ENV.token]!
    const params = { sessionId: 's1', request: INPUT }
    const others = Object.keys(METHOD_RIGHTS).filter((m) => m !== GATE_METHOD)
    expect(others.length).toBeGreaterThan(100)
    for (const m of others) expect(gateRefusal('s1', m, params)).toMatch(/cannot call/)
    expect(gateRefusal('s1', GATE_METHOD, params)).toBeNull()
    // The key is no hello on the WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const closed = new Promise<number>((r) => ws.addEventListener('close', (e) => r(e.code)))
    await new Promise<void>((r) => ws.addEventListener('open', () => r()))
    ws.send(JSON.stringify({ kind: 'hello', token: key, protocolVersion: PROTOCOL_VERSION }))
    expect(await closed).toBe(4001)
    // Nor does it open the HTTP door's routes, which want their own secret
    expect((await post(`http://127.0.0.1:${port}/${deriveHttpSecret(TOKEN)}/views/x`, key, '', 'GET')).status).toBe(404)
  })

  it('refuses gate.ask on the WebSocket to every credential, the token’s included', async () => {
    const { port } = await host()
    for (const token of [TOKEN, limitedToken(TOKEN)]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      const frames: { kind?: string; id?: string; ok?: boolean; error?: { data?: unknown } }[] = []
      ws.addEventListener('message', (e: MessageEvent<string>) => frames.push(JSON.parse(e.data) as (typeof frames)[number]))
      await new Promise<void>((r) => ws.addEventListener('open', () => r()))
      ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION }))
      await until(() => frames.some((f) => f.kind === 'hello_ok'))
      ws.send(JSON.stringify({ kind: 'rpc', id: 'x', method: GATE_METHOD, params: { sessionId: 's1', request: INPUT } }))
      await until(() => frames.some((f) => f.id === 'x'))
      expect(frames.find((f) => f.id === 'x')).toMatchObject({ ok: false, error: { data: { refused: 'rights', rights: 'gate' } } })
      ws.close()
    }
  })

  it('holds a session to a bound of open requests, so a loop in a shell cannot grow the host', async () => {
    const { gates } = await host({ maxOpenPerSession: 2 })
    const g = cardGate()
    const ch = await gates.open('s1', g.gate)
    const open = [hook(ch.env, { ...INPUT, stepIdx: 1 }), hook(ch.env, { ...INPUT, stepIdx: 2 })]
    await until(() => g.asked.length === 2)
    expect((await post(ch.env[GATE_ENV.url]!, ch.env[GATE_ENV.token]!, JSON.stringify({ ...INPUT, stepIdx: 3 }))).status).toBe(429)
    await ch.close()
    expect((await Promise.all(open)).map((a) => a.decision)).toEqual(['deny', 'deny'])
  })

  it('denies when the session’s gate throws or cannot read the call, and stays up', async () => {
    const { gates } = await host()
    const ch = await gates.open('s1', {
      read,
      decide: () => {
        throw new Error(`boom ${TOKEN}`)
      },
    })
    expect(await hook(ch.env)).toEqual({ decision: 'deny', reason: 'Centralu could not decide on this call, so it was not run.' })
    expect((await hook(ch.env, { conversationId: 'c', toolCall: 'not a call' })).decision).toBe('deny')
    expect(await hook(ch.env)).toMatchObject({ decision: 'deny' })
  })

  it('opening a session’s gate again revokes the key before', async () => {
    const { gates } = await host()
    const first: GateChannel = await gates.open('s1', cardGate().gate)
    const second = await gates.open('s1', cardGate().gate)
    expect(await post(first.env[GATE_ENV.url]!, first.env[GATE_ENV.token]!, JSON.stringify(INPUT))).toEqual({ status: 404, text: 'not found' })
    // The earlier channel's close does not close the later one
    await first.close()
    expect(gates.size).toBe(1)
    await second.close()
    expect(gates.size).toBe(0)
  })
})

describe('scrub', () => {
  it('takes out the given secrets and anything shaped like this host’s credentials', () => {
    expect(scrub('a sekrit-value-1234 b ccl1:abc_DEF-1 c ccb1:s1:mac', ['sekrit-value-1234'])).toBe('a [redacted] b [redacted] c [redacted]')
  })
})

describe('GateRequests under the door', () => {
  it('is what the door waits on, so a close denies what is open', async () => {
    const r = new GateRequests()
    const w = r.wait('1')
    r.close('closing')
    expect(await w).toEqual({ decision: 'deny', reason: 'closing' })
  })
})
