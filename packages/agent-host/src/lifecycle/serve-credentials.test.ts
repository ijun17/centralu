/** A `centralu serve` host's full credentials, as serve.json's verifiers (#1405) */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, type RawData } from 'ws'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { HostServer } from '../transport/server.js'
import { credentialProof, hostProof, proofNonce, provesCredential } from '../transport/host-proof.js'
import { limitedToken } from '../transport/limited-token.js'
import { isFullCredential, readFullCredentials, verifierOf, type FullCredential } from './serve-credentials.js'

const KEY = 'k'.repeat(43)
const HUB = 'h'.repeat(43)
const WINDOW = 'w'.repeat(43)
const entry = (id: string, token: string) => ({ id, label: id, verifier: verifierOf(token), created: 1 })

describe('reading the full credentials', () => {
  it('reads each entry of a version 2 file, and none of anything else', () => {
    const file = JSON.stringify({ v: 2, key: KEY, port: 1, full: [entry('aaaaaaaa', HUB), { id: 'bad', verifier: 'not hex' }, entry('bbbbbbbb', WINDOW)] })
    expect(readFullCredentials('x', () => file).map((c) => c.id)).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(readFullCredentials('x', () => JSON.stringify({ v: 1, token: HUB }))).toEqual([])
    expect(readFullCredentials('x', () => 'half')).toEqual([])
  })

  it('reads again when the file is caught mid-replace, and names none when it stays unreadable', () => {
    let reads = 0
    const flaky = () => (++reads < 3 ? '' : JSON.stringify({ v: 2, key: KEY, full: [entry('aaaaaaaa', HUB)] }))
    expect(readFullCredentials('x', flaky)).toHaveLength(1)
    expect(readFullCredentials('x', () => { throw new Error('EBUSY') })).toEqual([])
  })

  it('takes a credential whose hash is one of them, and nothing else', () => {
    const full: FullCredential[] = [entry('aaaaaaaa', HUB)]
    expect(isFullCredential(full, HUB)?.id).toBe('aaaaaaaa')
    expect(isFullCredential(full, WINDOW)).toBeNull()
    expect(isFullCredential(full, verifierOf(HUB))).toBeNull()
  })
})

let dir = ''
let server: HostServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const text = (d: RawData) => (Buffer.isBuffer(d) ? d : Array.isArray(d) ? Buffer.concat(d) : Buffer.from(d)).toString('utf8')

/** A host as `centralu serve` starts one: its key as the token, its full credentials those the file names */
async function serveHost(full: object[]) {
  dir = mkdtempSync(join(tmpdir(), 'cc-serve-cred-'))
  const file = join(dir, 'serve.json')
  const write = (entries: object[]) => writeFileSync(file, JSON.stringify({ v: 2, key: KEY, port: null, full: entries }))
  write(full)
  server = new HostServer({ port: 0, token: KEY, fullCredentials: () => readFullCredentials(file), onRpc: async () => ({ ok: true }) })
  const port = await server.listen()
  return { port, write }
}

/** The frames a socket gets for what it sends first (a prove, a hello), and the code it closed with, if it did */
async function exchange(port: number, first: object): Promise<{ frames: Record<string, unknown>[]; closed: number | null }> {
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

const hello = (port: number, token: string) => exchange(port, { kind: 'hello', token, protocolVersion: PROTOCOL_VERSION })

describe('a centralu serve host takes as full only the credentials serve.json names (#1405)', () => {
  it('lets a paired credential in, not the key it was handed, and the limited credential as a client', async () => {
    const { port } = await serveHost([entry('aaaaaaaa', HUB)])
    expect((await hello(port, HUB)).frames[0]).toMatchObject({ kind: 'hello_ok' })
    expect((await hello(port, KEY)).closed).toBe(4001)
    expect((await hello(port, limitedToken(KEY))).frames[0]).toMatchObject({ kind: 'hello_ok' })
  })

  it('reads the file at each hello: a pairing lets the next one in, a revocation keeps it out', async () => {
    const { port, write } = await serveHost([entry('aaaaaaaa', HUB)])
    expect((await hello(port, WINDOW)).closed).toBe(4001)
    write([entry('aaaaaaaa', HUB), entry('bbbbbbbb', WINDOW)])
    expect((await hello(port, WINDOW)).frames[0]).toMatchObject({ kind: 'hello_ok' })
    write([entry('bbbbbbbb', WINDOW)])
    expect((await hello(port, HUB)).closed).toBe(4001)
  })

  it("proves under the named credential's verifier, which only its holder can check, and under the key otherwise", async () => {
    const { port } = await serveHost([entry('aaaaaaaa', HUB)])
    const nonce = proofNonce()
    const named = (await exchange(port, { kind: 'prove', nonce, credential: 'aaaaaaaa' })).frames[0] as { mac: string }
    expect(named.mac).toBe(credentialProof(verifierOf(HUB), nonce))
    expect(provesCredential(verifierOf(HUB), nonce, named.mac)).toBe(true)
    expect(provesCredential(verifierOf(WINDOW), nonce, named.mac)).toBe(false)
    // No credential named, or one it does not hold: the proof the launcher's own probe checks, under the key
    const plain = (await exchange(port, { kind: 'prove', nonce })).frames[0] as { mac: string }
    expect(plain.mac).toBe(hostProof(KEY, nonce))
    const unknown = (await exchange(port, { kind: 'prove', nonce, credential: 'cccccccc' })).frames[0] as { mac: string }
    expect(unknown.mac).toBe(hostProof(KEY, nonce))
  })
})
