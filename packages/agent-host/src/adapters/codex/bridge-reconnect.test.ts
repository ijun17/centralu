import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { bridgePath } from './bridge-path.js'

/**
 * The Codex bridge across a host swap (#280 step 3).
 *
 * Under the keeper the bridge's CC_HOST_URL is the front door, which stays put while the host behind it
 * is replaced, and a swap closes every connection through it. A running codex keeps the bridge it
 * started, so the bridge has to fail the call that was cut off at once and reach the next host on the
 * following call, instead of sitting on a dead socket until the call's own 60 s timeout.
 */

let wss: WebSocketServer | null = null
let child: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  child?.kill()
  child = null
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
  wss = null
})

describe('the Codex bridge across a host swap (#280 step 3)', () => {
  it('fails a call whose connection closed at once, and the next call reaches the next host', async () => {
    let connections = 0
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('connection', (ws: WebSocket) => {
      const n = ++connections
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as { kind: string; id?: string }
        if (f.kind === 'hello') return void ws.send(JSON.stringify({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0 }))
        // The first host goes away mid-call (the swap); the one after it answers
        if (n === 1) return void ws.close(1001, 'host shutting down')
        ws.send(JSON.stringify({ kind: 'res', id: f.id, ok: true, result: { text: 'from the next host' } }))
      })
    })
    await new Promise<void>((r) => wss!.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    child = spawn(process.execPath, [bridgePath()], {
      env: { ...process.env, CC_HOST_URL: `ws://127.0.0.1:${port}`, CC_HOST_TOKEN: 't', CC_SESSION_ID: 's1' },
    })
    const got: { id: number; result: { content: { text: string }[]; isError: boolean } }[] = []
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) got.push(JSON.parse(line))
      }
    })
    const call = async (id: number) => {
      child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } })}\n`)
      const t0 = Date.now()
      while (!got.some((m) => m.id === id)) {
        if (Date.now() - t0 > 8_000) throw new Error(`no answer to call ${id} within 8s`)
        await new Promise((r) => setTimeout(r, 25))
      }
      return { answer: got.find((m) => m.id === id)!, ms: Date.now() - t0 }
    }

    const first = await call(1)
    expect(first.answer.result.isError).toBe(true)
    expect(first.answer.result.content[0]!.text).toContain('closed before it answered')
    expect(first.ms).toBeLessThan(5_000)

    const second = await call(2)
    expect(second.answer.result.isError).toBe(false)
    expect(second.answer.result.content[0]!.text).toBe('from the next host')
    expect(connections).toBe(2)
  }, 20_000)
})
