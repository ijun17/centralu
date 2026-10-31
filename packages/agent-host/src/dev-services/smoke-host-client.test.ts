import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { SLOW } from '../../../../tooling/test-timing.js'
import { connect, openHost, type Json } from '../../scripts/host-client.mjs'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'

/**
 * The client the smoke scripts share (scripts/host-client.mjs), against a stand-in host on a local port: what it says
 * to the host, what it hands the script, and when it gives up. One case starts the real host.
 */

const servers: WebSocketServer[] = []
const hosts: { host: { kill: () => boolean } }[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of hosts.splice(0)) h.host.kill()
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate()
    await new Promise((r) => s.close(r))
  }
  for (const d of dirs.splice(0)) await removeTree(d)
})

/** A host that greets a good token and answers each rpc with `answer(method, params, send)`; `send` pushes a frame */
async function standIn(answer: (method: string, params: unknown, send: (frame: Json) => void) => void): Promise<{ port: number; token: string; hellos: Json[] }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  servers.push(wss)
  await new Promise((r) => wss.once('listening', r))
  const hellos: Json[] = []
  wss.on('connection', (ws) => {
    const send = (frame: Json) => ws.send(JSON.stringify(frame))
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as Json
      if (f.kind === 'hello') {
        hellos.push(f)
        send({ kind: 'hello_ok' })
      } else if (f.kind === 'rpc') answer(String(f.method), f.params, (frame) => send({ ...frame, id: f.id }))
    })
  })
  return { port: (wss.address() as { port: number }).port, token: 'stand-in', hellos }
}

describe('the smokes\' host client', () => {
  it('says hello with the token, and resolves a call with the host\'s result or its error message', async () => {
    const host = await standIn((method, params, send) => send(method === 'fail' ? { kind: 'res', ok: false, error: { message: 'no such thing' } } : { kind: 'res', ok: true, result: { method, params } }))
    const client = await connect(host)
    expect(host.hellos).toEqual([{ kind: 'hello', token: 'stand-in', protocolVersion: 1 }])
    expect(await client.call('projects.add', { path: '/x' })).toEqual({ method: 'projects.add', params: { path: '/x' } })
    await expect(client.call('fail')).rejects.toThrow('no such thing')
  })

  it('keeps every event, hands each to onEvent, and waits for one seen already or arriving, from an index on', async () => {
    let push: (frame: Json) => void = () => {}
    const host = await standIn((_m, _p, send) => {
      push = (frame) => send(frame)
      send({ kind: 'res', ok: true, result: null })
    })
    const seen: string[] = []
    const client = await connect(host, { onEvent: (e) => seen.push(String(e.type)) })
    await client.call('start')
    push({ kind: 'event', event: { type: 'first' } })
    const first = await client.next((e) => e.type === 'first', 'first')
    expect(first).toEqual({ type: 'first' })
    const later = client.next((e) => e.type === 'later', 'later')
    push({ kind: 'event', event: { type: 'later' } })
    expect(await later).toEqual({ type: 'later' })
    await expect(client.next((e) => e.type === 'first', 'first again', 50, 1)).rejects.toThrow('no first again in 50 ms')
    expect(client.events.map((e) => e.type)).toEqual(['first', 'later'])
    expect(seen).toEqual(['first', 'later'])
  })

  it('ends a turn at its session\'s turn_complete and returns that session\'s events of the turn only', async () => {
    const host = await standIn((method, params, send) => {
      send({ kind: 'res', ok: true, result: null })
      if (method !== 'agents.send') return
      const sessionId = (params as Json).sessionId as string
      for (const e of [{ sessionId: 'other', type: 'message_delta' }, { sessionId, type: 'message_delta' }, { sessionId: 'other', type: 'turn_complete' }, { sessionId, type: 'turn_complete' }]) send({ kind: 'event', event: e })
    })
    const client = await connect(host)
    const events = await client.turn('mine', 'hello')
    expect(events).toEqual([
      { sessionId: 'mine', type: 'message_delta' },
      { sessionId: 'mine', type: 'turn_complete' },
    ])
  })

  it('rejects a call the host does not answer within timeoutMs', async () => {
    const host = await standIn(() => {})
    const client = await connect(host, { timeoutMs: 100 })
    await expect(client.call('silent')).rejects.toThrow('silent timeout')
  })

  it('starts the real host on a store of its own, and a call reaches it', async () => {
    const data = tempRoot('cc-host-client-')
    dirs.push(data)
    const client = await openHost({ env: { CC_DATA_DIR: data } })
    hosts.push(client)
    expect(await client.call('projects.list', {})).toEqual([])
    client.ws.close()
  }, 60_000 * SLOW)
})
