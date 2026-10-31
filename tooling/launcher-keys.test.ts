/**
 * The launcher's side of a hub's key pairing (#1711, docs/plans/key-pairing.md §4.2, slice 3): `--pair-key` and
 * `--key-paired`, `keys` in serve.json, the probe of the running host and its four outcomes, and the launcher's copy of
 * the key rules held to the host's (`link-keys.ts`) and to the pinned vector.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { vector } from './key-pairing-vector.mjs'
import { SLOW } from './test-timing.js'
import { HostServer } from '../packages/agent-host/src/transport/server.js'
import { readCredentialFile } from '../packages/agent-host/src/lifecycle/serve-credentials.js'
import { hostProof } from '../packages/agent-host/src/transport/host-proof.js'
import { hostLinkKey, LINK_AUTH_MARKER, linkAddress, linkPublicKeyOf, linkTranscript, parseLinkPublicKey as hostParse, signLink } from '../packages/agent-host/src/transport/link-keys.js'
import {
  ensureServeState,
  pairKeyServe,
  pairServe,
  dropVerifierUnder,
  parseServeArgs,
  readServeState,
  recordServePort,
  revokeServe,
  rotateServeToken,
  takesKeyHellos,
  parseLinkPublicKey,
  hostLinkPublicKey,
  signedHostKey,
  probeKeyProof,
  linkTranscript as launcherTranscript,
  SERVE_STATE_FILE,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/serve.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'packaging/npm/centralu/bin/centralu.mjs')
const SOURCE_HOST = join(ROOT, 'packages/agent-host/src/main.ts')

const dirs: string[] = []
const closers: (() => Promise<unknown>)[] = []
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cc-keys-')))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** A hub's public key, as slice 4's key file will hold one */
const hubKey = () => linkPublicKeyOf(generateKeyPairSync('ed25519').privateKey)!.text
/** The identity point, a small-order key (§4.1) */
const IDENTITY = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('base64url')

/** `centralu serve <args>` in a temporary data folder: exit code, the last stdout line as JSON, stderr */
async function cli(dataDir: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number; line: Record<string, any> | null; stderr: string }> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, 'serve', ...args],
      { cwd: ROOT, env: { ...process.env, CC_DATA_DIR: dataDir, CENTRALU_HOST_ENTRY: SOURCE_HOST, CI: '1', CENTRALU_SIGNIN_TASK: 'off', ...extra } },
      (err, stdout, stderr) => {
        const last = stdout.trim().split('\n').at(-1) ?? ''
        let line: Record<string, any> | null = null
        try {
          line = JSON.parse(last) as Record<string, any>
        } catch {
          // no line
        }
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, line, stderr })
      },
    )
  })
}

const fileOf = (d: string) => JSON.parse(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')) as Record<string, any>

describe('the launcher holds the host’s key rules (§4.1, §4.3)', () => {
  it('refuses exactly what the host refuses: every small-order encoding, y ≥ p, a wrong length or alphabet, a spare bit', () => {
    const P = 2n ** 255n - 19n
    const enc = (y: bigint, sign: boolean) => {
      const b = Buffer.alloc(32)
      let v = y
      for (let i = 0; i < 32; i++) {
        b[i] = Number(v & 0xffn)
        v >>= 8n
      }
      if (sign) b[31]! |= 0x80
      return b.toString('base64url')
    }
    const order8 = ['26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'].map((h) => Buffer.from(h, 'hex'))
    const refused = [
      ...[0n, 1n, P - 1n].flatMap((y) => [enc(y, false), enc(y, true)]),
      ...order8.flatMap((b) => [b.toString('base64url'), Buffer.from([...b.subarray(0, 31), b[31]! ^ 0x80]).toString('base64url')]),
      ...Array.from({ length: 19 }, (_, i) => P + BigInt(i)).flatMap((y) => [enc(y, false), enc(y, true)]),
      'A'.repeat(42),
      'A'.repeat(44),
      `${hubKey().slice(0, 42)}+`,
      `${vector().hubKey.slice(0, 42)}${String.fromCharCode(vector().hubKey.charCodeAt(42) + 1)}`,
      '',
      undefined,
    ]
    for (const k of refused) {
      expect(parseLinkPublicKey(k), String(k)).toBeNull()
      expect(hostParse(k), String(k)).toBeNull()
    }
    for (const k of [vector().hubKey, vector().hostKey, hubKey()]) {
      expect(parseLinkPublicKey(k)?.text).toBe(k)
      expect(hostParse(k)?.text).toBe(k)
    }
  }, 30_000 * SLOW)

  it('derives the host key the host signs with, and builds the vector’s transcript byte for byte', () => {
    const v = vector()
    expect(hostLinkPublicKey('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')).toBe(v.hostKey)
    const key = 'k'.repeat(43)
    expect(hostLinkPublicKey(key)).toBe(hostLinkKey(key).publicKey.text)
    const input = { hubNonce: Buffer.alloc(24, 0x11).toString('base64url'), hostNonce: Buffer.alloc(24, 0x22).toString('base64url'), hostKey: v.hostKey, hubKey: v.hubKey, keyId: 'a1b2c3d4', address: '127.0.0.1:4100' }
    expect(launcherTranscript(input).toString('hex')).toBe(v.transcript)
    for (const address of ['127.0.0.1:04100', '127.0.0.1:0', '127.0.0.1:65536', 'localhost:4100', '127.0.0.1:4100 ']) expect(launcherTranscript({ ...input, address }), address).toBeNull()
    expect(() => hostLinkPublicKey('')).toThrow()
  })

  it('takes a host’s proof only when its signature verifies over the hub’s key, the entry and the port', () => {
    const v = vector()
    const hubNonce = Buffer.alloc(24, 0x11).toString('base64url')
    const proof = { kind: 'proof', nonce: hubNonce, mac: 'x', hostNonce: Buffer.alloc(24, 0x22).toString('base64url'), hostKey: v.hostKey, sig: v.hostSig }
    const want = { hubNonce, hubKey: v.hubKey, keyId: 'a1b2c3d4', port: 4100 }
    expect(signedHostKey(proof, want)).toBe(v.hostKey)
    // The hub's signature is not the host's (role labels), and every other value changes what was signed
    expect(signedHostKey({ ...proof, sig: v.hubSig }, want)).toBeNull()
    expect(signedHostKey(proof, { ...want, port: 4101 })).toBeNull()
    expect(signedHostKey(proof, { ...want, keyId: 'a1b2c3d5' })).toBeNull()
    expect(signedHostKey(proof, { ...want, hubKey: hubKey() })).toBeNull()
    expect(signedHostKey(proof, { ...want, hubNonce: Buffer.alloc(24, 0x12).toString('base64url') })).toBeNull()
    expect(signedHostKey({ ...proof, hostKey: hubKey() }, want)).toBeNull()
    expect(signedHostKey({ kind: 'proof', nonce: hubNonce, mac: 'x' }, want)).toBeNull()
    // An answer to another prove: the nonce it echoes is not this one
    expect(signedHostKey({ ...proof, nonce: Buffer.alloc(24, 0x12).toString('base64url') }, want)).toBeNull()
  })
})

describe('serve --connection --pair-key (§4.2)', () => {
  it('takes a label and a public key the host takes, with --connection only, and --key-paired with it only', () => {
    const k = hubKey()
    expect(parseServeArgs(['--connection', '--pair-key', 'hub:a-0123abcd', k])).toEqual({ mode: 'connection', port: null, pairKey: { label: 'hub:a-0123abcd', publicKey: k }, keyPaired: false })
    expect(parseServeArgs(['--connection', '--pair-key', 'hub:a', k, '--key-paired'])).toMatchObject({ pairKey: { label: 'hub:a', publicKey: k }, keyPaired: true })
    expect(parseServeArgs(['--pair-key', 'hub:a', k]).error).toMatch(/--pair-key goes with --connection/)
    expect(parseServeArgs(['--connection', '--key-paired']).error).toMatch(/--key-paired goes with --pair-key/)
    expect(parseServeArgs(['--connection', '--pair', 'hub:a', '--pair-key', 'hub:a', k]).error).toMatch(/pass one/)
    expect(parseServeArgs(['--connection', '--pair-key', 'hub a', k]).error).toMatch(/needs a label/)
    for (const bad of [IDENTITY, undefined, 'A'.repeat(42), `${k}A`]) {
      expect(parseServeArgs(['--connection', '--pair-key', 'hub:a', ...(bad === undefined ? [] : [bad])]).error, String(bad)).toMatch(/needs an Ed25519 public key/)
    }
  })

  it('refuses a small-order key at the command line and writes nothing, not even a new serve.json', async () => {
    const d = tempDir()
    const r = await cli(d, ['--connection', '--pair-key', 'hub:a', IDENTITY])
    expect(r.code).toBe(2)
    expect(r.line).toBeNull()
    // Refused for its key, not as an option this serve does not know (an older one exits 2 for that)
    expect(r.stderr).toMatch(/--pair-key needs an Ed25519 public key/)
    expect(existsSync(join(d, SERVE_STATE_FILE))).toBe(false)
    // The same command with a key the host takes pairs
    const good = tempDir()
    expect((await cli(good, ['--connection', '--pair-key', 'hub:a', hubKey()])).code).toBe(0)
    expect(fileOf(good).keys).toHaveLength(1)
    // And the writer refuses one handed to it directly
    ensureServeState(d)
    const before = readFileSync(join(d, SERVE_STATE_FILE), 'utf8')
    expect(() => pairKeyServe(d, 'hub:a', IDENTITY)).toThrow(/refused public key/)
    expect(readFileSync(join(d, SERVE_STATE_FILE), 'utf8')).toBe(before)
  })

  it('keeps one key entry per label: the same key keeps its id, another gets a new id marked replaced, and the verifier entry stays', () => {
    const d = tempDir()
    const verifier = pairServe(d, 'hub:a')
    const k1 = hubKey()
    const first = pairKeyServe(d, 'hub:a', k1, process.platform, 1)
    expect(first.entry).toEqual({ id: expect.stringMatching(/^[0-9a-f]{8}$/), label: 'hub:a', publicKey: k1, created: 1, via: 'pair-key' })
    expect(pairKeyServe(d, 'hub:a', k1, process.platform, 2).entry).toEqual(first.entry)
    const k2 = hubKey()
    const second = pairKeyServe(d, 'hub:a', k2, process.platform, 3)
    expect(second.entry).toMatchObject({ label: 'hub:a', publicKey: k2, replaced: true })
    expect(second.entry.id).not.toBe(first.entry.id)
    pairKeyServe(d, 'hub:b', k1)
    const file = fileOf(d)
    expect(file.v).toBe(2)
    expect(file.keys.map((k: { label: string }) => k.label).sort()).toEqual(['hub:a', 'hub:b'])
    expect(file.keys.filter((k: { label: string }) => k.label === 'hub:a')).toEqual([second.entry])
    expect(file.full).toEqual([expect.objectContaining({ id: verifier.id, label: 'hub:a' })])
    // --key-paired's removal takes the verifier entry and leaves the key entries
    dropVerifierUnder(d, 'hub:a')
    expect(fileOf(d).full).toEqual([])
    expect(fileOf(d).keys).toHaveLength(2)
  })

  // #1717 review, L2: the host takes the first entry of an id, so an entry ahead of the hub's with its id would keep the hub from linking
  it('gives the hub’s entry a new id when another key entry shares its id, and keeps the id when none does', () => {
    const d = tempDir()
    const k1 = hubKey()
    const mine = pairKeyServe(d, 'hub:a', k1, process.platform, 1).entry
    const f = fileOf(d)
    const squatter = { id: mine.id, label: 'hub:x', publicKey: hubKey(), created: 1, via: 'pair-key' }
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ ...f, keys: [squatter, ...f.keys] }))
    const again = pairKeyServe(d, 'hub:a', k1, process.platform, 2).entry
    expect(again).toMatchObject({ label: 'hub:a', publicKey: k1 })
    expect(again.id).not.toBe(mine.id)
    const ids = fileOf(d).keys.map((k: { id: string }) => k.id)
    expect(new Set(ids).size).toBe(ids.length)
    // The other entry stays, and the next call finds no clash
    expect(fileOf(d).keys).toContainEqual(expect.objectContaining({ label: 'hub:x', id: mine.id }))
    expect(pairKeyServe(d, 'hub:a', k1, process.platform, 3).entry).toEqual(again)
  })

  // #1717 recheck, F1: the host takes no key entry whose id a verifier entry has, so the hub's entry must not keep such an id
  it('gives the hub’s entry a new id when a verifier entry has its id, and leaves the verifier entry as it is', () => {
    const d = tempDir()
    const k1 = hubKey()
    const mine = pairKeyServe(d, 'hub:a', k1, process.platform, 1).entry
    const f = fileOf(d)
    const verifier = { id: mine.id, label: 'hub:x', verifier: 'a'.repeat(64), created: 1 }
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ ...f, full: [verifier, ...f.full] }))
    const again = pairKeyServe(d, 'hub:a', k1, process.platform, 2).entry
    expect(again).toMatchObject({ label: 'hub:a', publicKey: k1 })
    expect(again.id).not.toBe(mine.id)
    expect(fileOf(d).full).toEqual([expect.objectContaining({ id: mine.id, label: 'hub:x' })])
    expect(pairKeyServe(d, 'hub:a', k1, process.platform, 3).entry).toEqual(again)
  })

  it('withdraws a key entry by id, and every one at --rotate-token; a hand-written refused key is dropped at the next write', () => {
    const d = tempDir()
    const a = pairKeyServe(d, 'hub:a', hubKey()).entry
    const b = pairKeyServe(d, 'hub:b', hubKey()).entry
    expect(revokeServe(d, a.id)).toBe(true)
    expect(fileOf(d).keys).toEqual([b])
    const f = fileOf(d)
    writeFileSync(join(d, SERVE_STATE_FILE), JSON.stringify({ ...f, keys: [...f.keys, { id: 'cccccccc', label: 'hub:c', publicKey: IDENTITY, created: 1, via: 'pair-key' }] }))
    expect(readServeState(d).keys).toEqual([b])
    rotateServeToken(d)
    expect(fileOf(d).keys).toBeUndefined()
    expect(readServeState(d).keys).toEqual([])
  })

  /*
   * §10 "Old builds": the launcher of the previous release (#1405) reads a file with `keys` and keeps its `full`; this is
   * its `parseServeState`, as it was, since a launcher rolled back to it is what reads the file next
   */
  it('leaves a file the previous release’s launcher reads whole: its full credentials and key', () => {
    const d = tempDir()
    const v = pairServe(d, 'hub:a')
    pairKeyServe(d, 'hub:a', hubKey())
    const before = previousParseServeState(readFileSync(join(d, SERVE_STATE_FILE), 'utf8'))
    expect(before).toMatchObject({ v: 2, key: readServeState(d).key, full: [expect.objectContaining({ id: v.id, label: 'hub:a' })] })
    // And the host of the previous release takes the same full credential
    expect(readCredentialFile(join(d, SERVE_STATE_FILE), (p) => readFileSync(p, 'utf8')).full.map((c) => c.id)).toEqual([v.id])
  })

  it('takes key hellos from a bundle that says keyPairing, and from the source', () => {
    const d = tempDir()
    writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1, verifiers: 1 }))
    expect(takesKeyHellos(join(d, 'main.mjs'))).toBe(false)
    writeFileSync(join(d, 'bundle-info.json'), JSON.stringify({ protocolVersion: 1, verifiers: 1, keyPairing: 1 }))
    expect(takesKeyHellos(join(d, 'main.mjs'))).toBe(true)
    expect(takesKeyHellos(SOURCE_HOST)).toBe(true)
  })
})

/** The previous release's `parseServeState` (serve-files.mjs at #1714), kept as a fixture: what a launcher rolled back reads */
function previousParseServeState(raw: string) {
  const isListedEntry = (e: any) => typeof e?.id === 'string' && /^[0-9a-f]{8}$/.test(e.id) && typeof e.label === 'string' && /^[A-Za-z0-9:._-]{1,80}$/.test(e.label) && typeof e.verifier === 'string' && /^[0-9a-f]{64}$/.test(e.verifier)
  try {
    const v = JSON.parse(raw)
    const port = Number.isInteger(v?.port) && v.port >= 1 && v.port <= 65535 ? v.port : null
    if (v?.v === 2) {
      if (typeof v.key !== 'string' || v.key.length < 32) return null
      const full = (Array.isArray(v.full) ? v.full : []).filter((e: unknown) => isListedEntry(e)).map((e: any) => ({ id: e.id, label: e.label, verifier: e.verifier, created: Number.isFinite(e.created) ? e.created : 0, ...(['pair', 'window', 'handover'].includes(e.via) ? { via: e.via } : {}), ...(e.replaced === true ? { replaced: true } : {}) }))
      const legacyHostToken = typeof v.legacyHostToken === 'string' && v.legacyHostToken.length >= 32 ? v.legacyHostToken : null
      return { v: 2, key: v.key, port, full, legacyHostToken }
    }
    return null
  } catch {
    return null
  }
}

/*
 * The probe and what the line says for each outcome (§4.2 step 3), through the real `centralu serve --connection`: a host
 * that signs, one that answers without a signature, one that says nothing, and nothing at all
 */
describe('what --pair-key reports for the host on the port', () => {
  const { WebSocketServer } = createRequire(join(ROOT, 'packages/agent-host/package.json'))('ws') as {
    WebSocketServer: new (o: { port: number; host: string }) => { on(e: string, f: (...a: any[]) => void): void; once(e: string, f: () => void): void; close(f: () => void): void }
  }

  async function freePort(): Promise<number> {
    return await new Promise((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as { port: number }
        s.close(() => resolve(port))
      })
    })
  }

  /** A folder whose recorded port is free, and a hub's key */
  async function folder() {
    const d = tempDir()
    ensureServeState(d)
    const port = await freePort()
    recordServePort(d, port)
    return { d, port, hub: hubKey() }
  }

  /** A host of this build on the folder's port: its key from the file, its credentials those the file names */
  async function newHost(d: string, port: number, key = String(readServeState(d).key)) {
    const server = new HostServer({ port, token: key, fullCredentials: () => readCredentialFile(join(d, SERVE_STATE_FILE), (f) => readFileSync(f, 'utf8'), () => {}), onRpc: async () => ({ ok: true }) })
    await server.listen()
    closers.push(() => server.close())
    return server
  }

  /** A host from before key pairing: a proof under the key, mac only, and a hello_ok for whoever proved it */
  async function oldHost(d: string, port: number) {
    const key = String(readServeState(d).key)
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    closers.push(() => new Promise<void>((r) => wss.close(() => r())))
    wss.on('connection', (ws: any) =>
      ws.on('message', (raw: unknown) => {
        const f = JSON.parse(String(raw)) as { kind: string; nonce?: string }
        ws.send(JSON.stringify(f.kind === 'prove' ? { kind: 'proof', nonce: f.nonce, mac: hostProof(key, f.nonce!) } : { kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired: false, currentSeq: 0 }))
      }),
    )
  }

  it('a host that signs: a key line with the key it signs with and the entry, pairKey in takes, and no credential', async () => {
    const { d, port, hub } = await folder()
    await newHost(d, port)
    const other = hubKey()
    pairKeyServe(d, 'hub:b', other)
    const { code, line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(code).toBe(0)
    const entry = fileOf(d).keys.find((k: { label: string }) => k.label === 'hub:a')
    expect(line).toMatchObject({ hostKey: hostLinkKey(String(readServeState(d).key)).publicKey.text, keyId: entry.id, takes: expect.arrayContaining(['pairKey']) })
    expect(line!.token).toBeUndefined()
    expect(line!.credential).toBeUndefined()
    expect(fileOf(d).full).toEqual([])
    // Another hub's key entry is listed with its public key; the one this line pairs is not
    expect(line!.others).toEqual([expect.objectContaining({ label: 'hub:b', publicKey: other })])
  })

  it('a host that answers a proof with only some of the signed fields: unknown, never unsigned', async () => {
    const { port, hub } = await folder()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    closers.push(() => new Promise<void>((r) => wss.close(() => r())))
    let answer: (nonce: string) => object = () => ({})
    wss.on('connection', (ws: any) => ws.on('message', (raw: unknown) => ws.send(JSON.stringify(answer((JSON.parse(String(raw)) as { nonce: string }).nonce)))))
    answer = (nonce) => ({ kind: 'proof', nonce, mac: 'x' })
    expect(await probeKeyProof({ port, keyId: 'a1b2c3d4', hubKey: hub })).toEqual({ outcome: 'unsigned' })
    for (const extra of [{ hostKey: hub }, { hostNonce: Buffer.alloc(24).toString('base64url') }, { sig: 'A'.repeat(86) }]) {
      answer = (nonce) => ({ kind: 'proof', nonce, mac: 'x', ...extra })
      expect(await probeKeyProof({ port, keyId: 'a1b2c3d4', hubKey: hub }), JSON.stringify(extra)).toEqual({ outcome: 'unknown' })
    }
  })

  it('nothing listening, nothing holding the folder, and an installed host from before key pairing: a verifier pairing', async () => {
    const { d, hub } = await folder()
    const bundle = tempDir()
    writeFileSync(join(bundle, 'bundle-info.json'), JSON.stringify({ protocolVersion: PROTOCOL_VERSION, verifiers: 1, hostProof: 1 }))
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub], { CENTRALU_HOST_ENTRY: join(bundle, 'main.mjs') })
    expect(line).toMatchObject({ token: expect.any(String), credential: expect.any(String), hostRunning: false })
    expect(line!.hostKey).toBeUndefined()
    expect(line!.takes).not.toContain('pairKey')
  })

  it('--key-paired removes the label’s verifier entry on a key line, and only on one', async () => {
    const { d, port, hub } = await folder()
    pairServe(d, 'hub:a')
    pairServe(d, 'window', process.platform, Date.now(), 'window')
    // No host signs (one from before key pairing runs): a verifier pairing, and the verifier entry is not removed
    await oldHost(d, port)
    const old = await cli(d, ['--connection', '--pair-key', 'hub:a', hub, '--key-paired'])
    expect(old.line).toMatchObject({ token: expect.any(String), credential: expect.any(String) })
    expect(old.line!.takes).not.toContain('pairKey')
    expect(old.line!.hostKey).toBeUndefined()
    expect(fileOf(d).full.map((e: { label: string }) => e.label).sort()).toEqual(['hub:a', 'window'])
    // The key entry stays: public, and used once a host that signs runs
    expect(fileOf(d).keys).toEqual([expect.objectContaining({ label: 'hub:a', publicKey: hub })])
    await closers.pop()!()
    await newHost(d, port)
    // A key line without --key-paired (the hub's first key link) leaves the verifier entry alone
    const first = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(first.line!.takes).toContain('pairKey')
    expect(fileOf(d).full.map((e: { label: string }) => e.label).sort()).toEqual(['hub:a', 'window'])
    const keyed = await cli(d, ['--connection', '--pair-key', 'hub:a', hub, '--key-paired'])
    expect(keyed.line!.takes).toContain('pairKey')
    expect(fileOf(d).full.map((e: { label: string }) => e.label)).toEqual(['window'])
    // Listed with the others: the window's verifier entry, never the key entry this line pairs
    expect(keyed.line!.others).toEqual([expect.objectContaining({ label: 'window' })])
  })

  it('a host that answers without a signature: a verifier pairing as --pair, no pairKey and no hostKey', async () => {
    const { d, port, hub } = await folder()
    await oldHost(d, port)
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line).toMatchObject({ token: expect.any(String), credential: fileOf(d).full[0].id, hostRunning: true })
    expect(line!.takes).not.toContain('pairKey')
    expect(line!.hostKey).toBeUndefined()
  })

  it('a port that takes the connection and says nothing: unknown, a verifier pairing', async () => {
    const { d, port, hub } = await folder()
    const sockets: Socket[] = []
    const silent: Server = createServer((s) => void sockets.push(s))
    await new Promise<void>((r) => silent.listen(port, '127.0.0.1', () => r()))
    closers.push(() => new Promise<void>((r) => (sockets.forEach((s) => s.destroy()), silent.close(() => r()))))
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line).toMatchObject({ token: expect.any(String), credential: expect.any(String) })
    expect(line!.takes).not.toContain('pairKey')
  }, 30_000 * SLOW)

  // Something listens and takes the WebSocket, then closes it before any proof: not nothing, so not a key derived from the file
  it('a port that accepts the connection and closes it before a proof: unknown, a verifier pairing, never the derived key', async () => {
    const { d, port, hub } = await folder()
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    closers.push(() => new Promise<void>((r) => wss.close(() => r())))
    wss.on('connection', (ws: any) => ws.close())
    expect(await probeKeyProof({ port, keyId: 'a1b2c3d4', hubKey: hub })).toEqual({ outcome: 'unknown' })
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line).toMatchObject({ token: expect.any(String), credential: expect.any(String) })
    expect(line!.takes).not.toContain('pairKey')
    expect(line!.hostKey).toBeUndefined()
  }, 30_000 * SLOW)

  it('nothing listening and nothing holding the folder: the key derived from the file, which the host started next signs with', async () => {
    const { d, hub } = await folder()
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line).toMatchObject({ hostKey: hostLinkPublicKey(String(readServeState(d).key)), keyId: fileOf(d).keys[0].id, hostRunning: false })
    expect(line!.takes).toContain('pairKey')
  })

  it('nothing listening while something holds the folder (a keeper’s host, one starting): unknown, a verifier pairing', async () => {
    const { d, hub } = await folder()
    // This test's own process as the holder: alive, and named by host.lock as a keeper's host would be
    writeFileSync(join(d, 'host.lock'), JSON.stringify({ pid: process.pid, started: null, by: 'keeper' }))
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line).toMatchObject({ token: expect.any(String), credential: expect.any(String) })
    expect(line!.hostKey).toBeUndefined()
  })

  /*
   * §7: `--rotate-token` with a host running. The sweep closes the hub's socket (its entry is gone), the next link writes
   * a new key entry, and the line reports the key the running host signs with, its old one, so the hub links at once
   */
  it('after --rotate-token with a host running, reports the key that host signs with, and the hub links with it at once', async () => {
    const { d, port } = await folder()
    const oldKey = String(readServeState(d).key)
    await newHost(d, port, oldKey)
    const hubPair = generateKeyPairSync('ed25519')
    const hub = linkPublicKeyOf(hubPair.privateKey)!.text
    expect((await cli(d, ['--connection', '--pair-key', 'hub:a', hub])).line!.hostKey).toBe(hostLinkKey(oldKey).publicKey.text)
    expect((await cli(d, ['--rotate-token'])).code).toBe(0)
    expect(String(readServeState(d).key)).not.toBe(oldKey)
    const { line } = await cli(d, ['--connection', '--pair-key', 'hub:a', hub])
    expect(line!.hostKey).toBe(hostLinkKey(oldKey).publicKey.text)
    expect(line!.hostKey).not.toBe(hostLinkPublicKey(String(readServeState(d).key)))
    expect(await keyHello(port, hubPair.privateKey, hub, line!.keyId, line!.hostKey)).toBe('hello_ok')
  })
})

/** The hub's key handshake (§4.3) against the host on `port`: `hello_ok`, or why not */
async function keyHello(port: number, hubPrivate: ReturnType<typeof generateKeyPairSync>['privateKey'], hub: string, keyId: string, lineHostKey: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const nonce = Buffer.from(Array.from({ length: 24 }, (_, i) => i)).toString('base64url')
  try {
    return await new Promise<string>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ kind: 'prove', nonce, key: keyId }))
      ws.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data)) as Record<string, any>
        if (f.kind === 'proof') {
          if (f.hostKey !== lineHostKey) return resolve('another host key')
          const t = linkTranscript({ hubNonce: nonce, hostNonce: f.hostNonce, hostKey: f.hostKey, hubKey: hub, keyId, address: linkAddress(port)! })
          if (!t) return resolve('no transcript')
          ws.send(JSON.stringify({ kind: 'hello', token: LINK_AUTH_MARKER, protocolVersion: PROTOCOL_VERSION, auth: { key: keyId, sig: signLink('hub', hubPrivate, t) } }))
        } else resolve(String(f.kind))
      }
      ws.onclose = (ev) => resolve(`closed ${ev.code}`)
    })
  } finally {
    ws.close()
  }
}

