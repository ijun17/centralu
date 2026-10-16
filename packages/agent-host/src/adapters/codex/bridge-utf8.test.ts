import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { bridgePath } from './bridge-path.js'

/**
 * The Codex bridge reads its stdin as one UTF-8 stream. A pipe can split a multibyte character between two
 * chunks; decoding each chunk on its own turned both halves into U+FFFD, and the tool's arguments reached the
 * host corrupted.
 */

let wss: WebSocketServer | null = null
let child: ChildProcessWithoutNullStreams | null = null

afterEach(async () => {
  child?.kill()
  child = null
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()))
  wss = null
})

describe('the Codex bridge reading its stdin', () => {
  it('keeps a Korean character that straddles two chunks', async () => {
    const seen: unknown[] = []
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        const f = JSON.parse(String(raw)) as { kind: string; id?: string; params?: { args?: unknown } }
        if (f.kind === 'hello') return void ws.send(JSON.stringify({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0 }))
        seen.push(f.params?.args)
        ws.send(JSON.stringify({ kind: 'res', id: f.id, ok: true, result: { text: 'done' } }))
      })
    })
    await new Promise<void>((r) => wss!.once('listening', () => r()))
    const port = (wss.address() as { port: number }).port

    child = spawn(process.execPath, [bridgePath()], {
      env: { ...process.env, CC_HOST_URL: `ws://127.0.0.1:${port}`, CC_BRIDGE_TOKEN: 't', CC_SESSION_ID: 's1' },
    })
    const got: { id: number; result?: { isError: boolean } }[] = []
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
      for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        if (line.trim()) got.push(JSON.parse(line))
      }
    })

    const answered = async (id: number) => {
      const t0 = Date.now()
      while (!got.some((m) => m.id === id)) {
        if (Date.now() - t0 > 8_000) throw new Error(`no answer to call ${id} within 8s`)
        await new Promise((r) => setTimeout(r, 25))
      }
      return got.find((m) => m.id === id)!
    }
    // Wait until the bridge reads its stdin, or both halves below would sit in the pipe and arrive as one chunk
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`)
    await answered(1)

    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'send_message', arguments: { text: '한국어' } } })}\n`,
    )
    // Cut inside the first character of '한' (three bytes in UTF-8) and let the halves arrive as separate chunks
    const cut = line.indexOf(Buffer.from('한')) + 1
    child.stdin.write(line.subarray(0, cut))
    await new Promise((r) => setTimeout(r, 150))
    child.stdin.write(line.subarray(cut))

    expect((await answered(7)).result?.isError).toBe(false)
    expect(seen).toEqual([{ text: '한국어' }])
  }, 20_000)
})
