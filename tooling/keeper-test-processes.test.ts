import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The keeper integration scripts are plain JavaScript that CI runs directly in Node.
import { alive, heldChildren, request, waitFor } from '../scripts/keeper-test-processes.mjs'
import { SLOW } from './test-timing.js'

/**
 * The keeper integration scripts' socket and process helpers (scripts/keeper-test-processes.mjs), against a stand-in
 * keeper on a local socket. The scripts themselves need the real keeper binary and run in CI's keeper job.
 */

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A keeper socket that answers each line with `answer(request, socket)`; a socket file in `dir`, a named pipe on Windows */
async function fakeKeeper(dir: string, name: string, answer: (req: Record<string, unknown>, c: Socket) => void): Promise<string> {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\cc-keeper-test-${process.pid}-${Date.now()}-${name}` : join(dir, name)
  const server = createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += String(d)
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        answer(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>, c)
        buf = buf.slice(nl + 1)
      }
    })
    c.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(path, r))
  return path
}

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-keeper-test-'))
  dirs.push(d)
  return d
}

describe('keeper integration helpers', () => {
  // keeper-integration.mjs gave up after 5 s while the other scripts waited 8 s; a keeper busy with a host start or a
  // swap under CI load takes that long
  it('waits 8 s for a keeper slow to answer', async () => {
    const sock = await fakeKeeper(tempDir(), 'keeper.sock', (req, c) => {
      setTimeout(() => c.write(`${JSON.stringify({ ok: true, view: { op: req.op } })}\n`), 6_000)
    })
    expect(await request(sock, { op: 'status' })).toEqual({ ok: true, view: { op: 'status' } })
  }, 20_000 * SLOW)

  it('still gives up on a keeper that never answers', async () => {
    const sock = await fakeKeeper(tempDir(), 'keeper.sock', () => {})
    await expect(request(sock, { op: 'status' }, 200)).rejects.toThrow('timeout')
  })

  // The child socket answers only the keeper's hosts (#538), so the scripts ask keeper.sock what it holds
  it('reads the held children from keeper.sock', async () => {
    const d = tempDir()
    const children = [{ id: 'c1', tag: { kind: 'terminal', id: 't1' } }]
    const sock = await fakeKeeper(d, 'keeper.sock', (req, c) => {
      c.write(`${JSON.stringify(req.op === 'children' ? { ok: true, children } : { ok: false, error: `unknown op ${String(req.op)}` })}\n`)
    })
    // heldChildren takes a data folder; on Windows the stand-in is a pipe, so ask it directly
    const held = process.platform === 'win32' ? ((await request(sock, { op: 'children' })) as { children: unknown }).children : await heldChildren(d)
    expect(held).toEqual(children)
  })

  it('waitFor returns the first truthy value, counts a throw as not yet, and gives undefined at the limit', async () => {
    let n = 0
    expect(await waitFor(() => {
      if (++n < 3) throw new Error('not there yet')
      return 'up'
    }, 5_000 * SLOW, 5)).toBe('up')
    expect(await waitFor(() => false, 50, 5)).toBeUndefined()
  })

  it('alive: this process is, a process that exists but may not be signalled is, no pid is not', () => {
    expect(alive(process.pid)).toBe(true)
    expect(alive(process.platform === 'win32' ? 4 : 1)).toBe(true)
    expect(alive(0)).toBe(false)
  })
})
