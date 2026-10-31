/**
 * The machine's side of a hub's key pairing (#1711, docs/plans/key-pairing.md §4.3, §4.4, slice 3): a `centralu serve`
 * host signs a key `prove`, takes a key hello, and closes a socket in by key once its entry goes. The hub's half is
 * played here with the module's own primitives (`link-keys.ts`), as slice 4's `RemoteClient` will.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { HostServer, type RpcContext } from './server.js'
import { hostProof, proofNonce } from './host-proof.js'
import { hostLinkKey, LINK_AUTH_MARKER, linkAddress, linkPublicKeyOf, linkTranscript, signLink, verifyLink, parseLinkPublicKey } from './link-keys.js'
import { credentialsReport, readCredentialFile, UsedCredentials, usedEvent, verifierOf } from '../lifecycle/serve-credentials.js'
import { answerKeyProve, HostSigningKey } from './link-proof.js'
import { limitedToken } from './limited-token.js'
import { sessionToken } from './session-token.js'
import { bridgeToken } from './bridge-token.js'
import { limitedRefusal } from './method-rights.js'

const KEY = 'k'.repeat(43)
const HUB_ID = 'aaaaaaaa'
const LABEL = 'hub:test-0123abcd'

/** A hub's key pair, as slice 4's key file will hold one */
function hubKeys(): { privateKey: KeyObject; text: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, text: linkPublicKeyOf(privateKey)!.text }
}

const keyEntry = (id: string, publicKey: string, label = LABEL) => ({ id, label, publicKey, created: 1, via: 'pair-key' })

let server: HostServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

type Call = { method: string; ctx: RpcContext | undefined }

/** A host as `centralu serve` starts one, its serve.json in memory: `write` replaces it as the launcher does */
async function serveHost(file: { full?: object[]; keys?: object[] }, opts: { port?: number; frontDoor?: string; credentialSweepMs?: number } = {}) {
  let text = ''
  /** While set, the file is there but cannot be read (permission denied, a scanner holding it) */
  let denied = false
  const used = new UsedCredentials()
  const heard: unknown[] = []
  /** What main.ts does at a full hello: the first use of a credential is recorded and told to the hubs (#1712) */
  const told: ReturnType<typeof usedEvent>[] = []
  const write = (f: { full?: object[]; keys?: object[] }) => (text = JSON.stringify({ v: 2, key: KEY, port: null, full: f.full ?? [], ...(f.keys ? { keys: f.keys } : {}) }))
  write(file)
  const calls: Call[] = []
  server = new HostServer({
    port: opts.port ?? 0,
    token: KEY,
    fullCredentials: () =>
      readCredentialFile('link-proof.json', () => {
        if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return text
      }, () => {}),
    onFullHello: (c) => {
      heard.push(c)
      const first = used.saw(c)
      if (!first) return
      told.push(usedEvent(first))
      server?.tellHubs(usedEvent(first))
    },
    ...(opts.frontDoor !== undefined ? { frontDoor: opts.frontDoor } : {}),
    ...(opts.credentialSweepMs ? { credentialSweepMs: opts.credentialSweepMs } : {}),
    onRpc: async (method, _params, ctx) => {
      calls.push({ method, ctx })
      return { ok: true }
    },
  })
  const port = await server.listen()
  return { port, write, calls, used, heard, told, text: () => text, deny: (v: boolean) => (denied = v) }
}

/** One socket to the host (Node's own WebSocket, as a hub's would be a client): what it sends, and what comes back */
async function peer(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: Record<string, unknown>[] = []
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>))
  let reason = ''
  let code: number | null = null
  const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => ((code = ev.code), (reason = ev.reason), r(ev.code))))
  ws.addEventListener('error', () => {})
  await new Promise<void>((r) => ws.addEventListener('open', () => r()))
  const wait = async (pred: () => boolean, ms = 3000) => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > ms) return false
      await new Promise((r) => setTimeout(r, 10))
    }
    return true
  }
  const send = (f: object) => ws.send(JSON.stringify(f))
  /** The next frame of `kind`, or null once the socket closed or nothing came */
  const next = async (kind: string) => {
    await wait(() => code !== null || frames.some((f) => f.kind === kind))
    return frames.find((f) => f.kind === kind) ?? null
  }
  let n = 0
  const call = async (method: string) => {
    const id = `c${++n}`
    send({ kind: 'rpc', id, method, params: {} })
    await wait(() => frames.some((f) => f.kind === 'res' && f.id === id))
    return frames.find((f) => f.kind === 'res' && f.id === id) as { ok: boolean } | undefined
  }
  return { ws, frames, closed, wait, send, next, call, code: () => code, reason: () => reason }
}

type Proof = { kind: 'proof'; nonce: string; mac: string; hostNonce?: string; hostKey?: string; sig?: string }

/** The hub's half (§4.3): its own prove, the host's signature checked over the transcript it builds, and the hello it would send */
async function hubDial(port: number, hub: { privateKey: KeyObject; text: string }, opts: { keyId?: string; address?: string; send?: boolean } = {}) {
  const keyId = opts.keyId ?? HUB_ID
  const p = await peer(port)
  const nonce = proofNonce()
  p.send({ kind: 'prove', nonce, key: keyId })
  const proof = (await p.next('proof')) as Proof | null
  const address = opts.address ?? linkAddress(port)!
  const t = proof?.hostNonce && proof.hostKey ? linkTranscript({ hubNonce: nonce, hostNonce: proof.hostNonce, hostKey: proof.hostKey, hubKey: hub.text, keyId, address }) : null
  const hostSigned = !!t && !!proof?.hostKey && verifyLink('host', parseLinkPublicKey(proof.hostKey)!, t, proof.sig)
  const helloFrame = t ? { kind: 'hello', token: LINK_AUTH_MARKER, protocolVersion: PROTOCOL_VERSION, auth: { key: keyId, sig: signLink('hub', hub.privateKey, t) } } : null
  if (opts.send !== false && helloFrame) p.send(helloFrame)
  return { p, proof, nonce, hostSigned, helloFrame }
}

const accepted = async (p: Awaited<ReturnType<typeof peer>>) => (await p.next('hello_ok')) !== null && p.code() === null

describe('the host signs a key prove and takes a key hello (§4.3)', () => {
  it('signs with the key derived from the one it was started with, over its own address, and lets the hub in as full', async () => {
    const hub = hubKeys()
    const { port, calls } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const d = await hubDial(port, hub)
    expect(d.proof).toMatchObject({ kind: 'proof', nonce: d.nonce, mac: hostProof(KEY, d.nonce), hostKey: hostLinkKey(KEY).publicKey.text })
    expect(d.hostSigned).toBe(true)
    expect(await accepted(d.p)).toBe(true)
    expect((await d.p.call('host.sessions'))?.ok).toBe(true)
    expect(calls.at(-1)?.ctx?.rights).toBe('full')
  })

  // §9 item 2: with `key` the nonce is exactly 24 bytes, and nothing answers a malformed one, the proof under the key included
  it('closes on a key prove whose nonce is not exactly 24 bytes, with no proof at all', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    for (const nonce of ['A'.repeat(22), 'A'.repeat(43), proofNonce().slice(0, 31), `${proofNonce()}A`, Buffer.alloc(25).toString('base64url')]) {
      // Malformed before anything else: also for an id naming no entry, which is never told "withdrawn" (a hub pairs anew on that)
      for (const key of [HUB_ID, 'cccccccc']) {
        const p = await peer(port)
        p.send({ kind: 'prove', nonce, key })
        expect(await p.closed, nonce).toBe(4001)
        expect(p.reason(), `${nonce} ${key}`).toBe('not a hello')
        expect(p.frames.filter((f) => f.kind === 'proof'), nonce).toEqual([])
      }
    }
  })

  // The entry is checked here too, not only where serve.json is read: one whose public key is refused gets no proof
  it('answers no key prove for an entry whose public key is refused, nor for one of another id', () => {
    const hub = hubKeys()
    const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('base64url')
    const signing = new HostSigningKey(KEY)
    const ask = { signing, nonce: proofNonce(), keyId: HUB_ID, address: linkAddress(4100) }
    expect(answerKeyProve({ ...ask, entry: keyEntry(HUB_ID, identity) })).toEqual({ refused: 'withdrawn' })
    expect(answerKeyProve({ ...ask, entry: keyEntry('bbbbbbbb', hub.text) })).toEqual({ refused: 'withdrawn' })
    expect(answerKeyProve({ ...ask, entry: undefined })).toEqual({ refused: 'withdrawn' })
    expect(answerKeyProve({ ...ask, entry: keyEntry(HUB_ID, hub.text) })).toHaveProperty('pending.keyId', HUB_ID)
  })

  it('closes on a key prove naming no entry, or one whose key is refused, as a credential withdrawn', async () => {
    const hub = hubKeys()
    // The identity point: small order, so on Node 22 a forged signature verifies under it for every message (§4.1)
    const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('base64url')
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text), keyEntry('bbbbbbbb', identity, 'hub:x')] })
    for (const key of ['cccccccc', 'bbbbbbbb']) {
      const p = await peer(port)
      p.send({ kind: 'prove', nonce: proofNonce(), key })
      expect(await p.closed).toBe(4001)
      expect(p.reason()).toBe('credential withdrawn')
    }
  })
})

describe('what a key hello is refused for (§4.3, §9)', () => {
  // Relay: the hub forwards to one port, the real host listens on another (§4.3, "Relay")
  it('refuses a transcript naming another address than the one this host signs', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const elsewhere = linkAddress(port === 65535 ? 1 : port + 1)!
    const d = await hubDial(port, hub, { address: elsewhere })
    // The hub itself would drop it (the host signed its own address), and the host refuses the hub's signature too
    expect(d.hostSigned).toBe(false)
    expect(await d.p.closed).toBe(4001)
    expect(d.p.frames.some((f) => f.kind === 'hello_ok')).toBe(false)
  })

  it('refuses a recorded key hello on a new socket, after that socket’s own prove', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const first = await hubDial(port, hub)
    expect(await accepted(first.p)).toBe(true)
    // The same hello again, on a socket whose prove drew another nonce
    const again = await peer(port)
    again.send({ kind: 'prove', nonce: first.nonce, key: HUB_ID })
    expect(await again.next('proof')).not.toBeNull()
    again.send(first.helloFrame!)
    expect(await again.closed).toBe(4001)
    // And with no prove at all
    const bare = await peer(port)
    bare.send(first.helloFrame!)
    expect(await bare.closed).toBe(4001)
  })

  it('refuses a second prove on one socket, so a recorded hello cannot follow a fresh one there', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const d = await hubDial(port, hub, { send: false })
    d.p.send({ kind: 'prove', nonce: proofNonce(), key: HUB_ID })
    expect(await d.p.closed).toBe(4001)
  })

  // §9 item 4: what a prove left is dropped at the first hello attempt, a failed one included
  it('drops the nonces at a failed hello: a good hello right after it on the same socket is refused', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const d = await hubDial(port, hub, { send: false })
    const wrong = hubKeys()
    const t = linkTranscript({ hubNonce: d.nonce, hostNonce: d.proof!.hostNonce!, hostKey: d.proof!.hostKey!, hubKey: hub.text, keyId: HUB_ID, address: linkAddress(port)! })!
    d.p.send({ ...d.helloFrame!, auth: { key: HUB_ID, sig: signLink('hub', wrong.privateKey, t) } })
    d.p.send(d.helloFrame!)
    expect(await d.p.closed).toBe(4001)
    expect(d.p.frames.some((f) => f.kind === 'hello_ok')).toBe(false)
  })

  // §9 item 3, and the order tests of §10: nothing in the hello stands in for what the prove left
  it('refuses auth on a socket that sent no key prove: no prove, or a prove without key', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    const ok = await hubDial(port, hub, { send: false })
    const plain = await peer(port)
    plain.send({ kind: 'prove', nonce: ok.nonce })
    expect(await plain.next('proof')).toMatchObject({ mac: hostProof(KEY, ok.nonce) })
    plain.send(ok.helloFrame!)
    expect(await plain.closed).toBe(4001)
    const none = await peer(port)
    none.send(ok.helloFrame!)
    expect(await none.closed).toBe(4001)
  })

  it('refuses an auth.key other than the one its prove named, even one whose own signature is good', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text), keyEntry('bbbbbbbb', hub.text, 'hub:other')] })
    const d = await hubDial(port, hub, { send: false })
    const t = linkTranscript({ hubNonce: d.nonce, hostNonce: d.proof!.hostNonce!, hostKey: d.proof!.hostKey!, hubKey: hub.text, keyId: 'bbbbbbbb', address: linkAddress(port)! })!
    d.p.send({ ...d.helloFrame!, auth: { key: 'bbbbbbbb', sig: signLink('hub', hub.privateKey, t) } })
    expect(await d.p.closed).toBe(4001)
    // And the signature over the prove's own transcript, under another auth.key: the key the hello names is the prove's
    const e = await hubDial(port, hub, { send: false })
    e.p.send({ ...e.helloFrame!, auth: { ...e.helloFrame!.auth, key: 'bbbbbbbb' } })
    expect(await e.p.closed).toBe(4001)
  })

  /*
   * §10 "The marker", the other half: a key hello that is good, in a file that also holds the marker's own verifier as a full
   * entry, is full under its key entry only. Taking the marker as a verifier credential too would record that entry as used
   * at this hello (and list it as gone later, under a label no hub paired it for)
   */
  it('takes a good key hello as the key entry alone, not also as a verifier entry equal to the marker', async () => {
    const hub = hubKeys()
    const { port, heard } = await serveHost({ full: [{ id: 'dddddddd', label: 'hub:x', verifier: verifierOf(LINK_AUTH_MARKER), created: 1 }], keys: [keyEntry(HUB_ID, hub.text)] })
    const d = await hubDial(port, hub)
    expect(await accepted(d.p)).toBe(true)
    expect(heard).toEqual([expect.objectContaining({ id: HUB_ID, publicKey: hub.text })])
  })

  // The sweep and the key prove read the same file as hellos do, but a prove is answered from what a socket in may keep
  it('answers a key prove from the last key entries while serve.json cannot be read, then refuses the hello for the unreadable file', async () => {
    const hub = hubKeys()
    const { port, deny } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    // One read of the file now, so that the last good list is kept
    expect(await accepted((await hubDial(port, hub)).p)).toBe(true)
    deny(true)
    const d = await hubDial(port, hub)
    // Not "credential withdrawn": the entry is not known to be gone, only unreadable (a hub that was told it pairs anew)
    expect(d.proof?.hostKey).toBe(hostLinkKey(KEY).publicKey.text)
    expect(d.hostSigned).toBe(true)
    expect(await d.p.closed).toBe(4001)
    expect(d.p.reason()).toBe('credential file unreadable')
    expect(d.p.frames.some((f) => f.kind === 'hello_ok')).toBe(false)
  })

  it('refuses the marker without auth, or with a malformed one: neither full nor limited', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    for (const auth of [undefined, { key: HUB_ID }, { key: HUB_ID, sig: 'x' }, { key: 'nothex!!', sig: 'A'.repeat(86) }]) {
      const d = await hubDial(port, hub, { send: false })
      d.p.send({ kind: 'hello', token: LINK_AUTH_MARKER, protocolVersion: PROTOCOL_VERSION, ...(auth ? { auth } : {}) })
      expect(await d.p.closed, JSON.stringify(auth)).toBe(4001)
    }
  })

  /*
   * §10 "The marker": a file whose full entry is the marker's own verifier (written by hand: `--pair` draws 32 random
   * bytes) still opens nothing by the marker. Without a key hello's own branch the marker would be a verifier credential
   */
  it('never takes the marker as a full credential of a file paired by verifier', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ full: [{ id: 'dddddddd', label: 'hub:x', verifier: verifierOf(LINK_AUTH_MARKER), created: 1 }], keys: [keyEntry(HUB_ID, hub.text)] })
    const p = await peer(port)
    p.send({ kind: 'hello', token: LINK_AUTH_MARKER, protocolVersion: PROTOCOL_VERSION })
    expect(await p.closed).toBe(4001)
  })

  // §9 item 3: an `auth` beside any other token is ignored, so it never upgrades a limited or a verifier hello
  it('ignores auth beside another token: the limited, a session’s and a bridge’s credential stay what they are', async () => {
    const hub = hubKeys()
    const { port, calls } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] })
    for (const token of [limitedToken(KEY), sessionToken(KEY, 's1')]) {
      const d = await hubDial(port, hub, { send: false })
      d.p.send({ ...d.helloFrame!, token })
      expect(await accepted(d.p)).toBe(true)
      expect((await d.p.call('host.sessions'))?.ok).toBe(false)
      d.p.ws.close()
    }
    expect(calls.every((c) => c.method !== 'host.sessions')).toBe(true)
    const b = await hubDial(port, hub, { send: false })
    b.p.send({ ...b.helloFrame!, token: bridgeToken(KEY, 's1') })
    expect(await b.p.next('hello_ok')).not.toBeNull()
    expect((await b.p.call('host.sessions'))?.ok).toBe(false)
  })
})

// §4.1: an entry written by hand with a refused public key is absent, both where hellos are checked and where it is listed
it('reads and lists no key entry whose public key is refused', () => {
  const hub = hubKeys()
  const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString('base64url')
  const text = JSON.stringify({ v: 2, key: KEY, port: null, full: [], keys: [keyEntry(HUB_ID, hub.text), keyEntry('bbbbbbbb', identity, 'hub:x')] })
  const read = readCredentialFile('refused-key.json', () => text, () => {})
  expect('keys' in read ? read.keys?.map((k) => k.id) : null).toEqual([HUB_ID])
  const report = credentialsReport('refused-key.json', () => text, new UsedCredentials())
  expect(report.credentials?.map((c) => c.id)).toEqual([HUB_ID])
})

/*
 * #1717 recheck, F1: a key entry has no secret, so a hub that is told of it has no `check` to compare, and takes an entry of
 * its own credential's id for its own. The host therefore takes no key entry whose id a verifier entry of the same file
 * has: not at a hello, not in the list. The verifier entry is untouched, whichever comes first in the file
 */
describe('a key entry whose id is also a verifier entry’s id (#1717 recheck, F1)', () => {
  const VERIFIER_TOKEN = 'v'.repeat(43)
  const verifierEntry = (id: string) => ({ id, label: LABEL, verifier: verifierOf(VERIFIER_TOKEN), created: 1 })

  it('is refused at a key hello, as a credential that is not there, and the verifier entry stays full', async () => {
    const hub = hubKeys()
    const { port, heard, used } = await serveHost({ full: [verifierEntry(HUB_ID)], keys: [keyEntry(HUB_ID, hub.text)] })
    const d = await hubDial(port, hub)
    expect(await accepted(d.p)).toBe(false)
    await d.p.closed
    expect(d.p.code()).toBe(4001)
    expect(d.p.reason()).toBe('credential withdrawn')
    expect(heard).toEqual([])
    expect(used.records()).toEqual([])
    const v = await peer(port)
    v.send({ kind: 'hello', token: VERIFIER_TOKEN, protocolVersion: PROTOCOL_VERSION })
    expect(await accepted(v)).toBe(true)
    expect(heard).toEqual([expect.objectContaining({ id: HUB_ID, verifier: verifierOf(VERIFIER_TOKEN) })])
  })

  it('is neither read nor listed, whichever entry is first in the file, while a key entry of another id is', () => {
    const [clash, fine] = [hubKeys(), hubKeys()]
    for (const full of [[verifierEntry(HUB_ID)], [verifierEntry('bbbbbbbb'), verifierEntry(HUB_ID)]]) {
      const text = JSON.stringify({ v: 2, key: KEY, port: null, full, keys: [keyEntry(HUB_ID, clash.text), keyEntry('cccccccc', fine.text, 'hub:other')] })
      const read = readCredentialFile('clash-key.json', () => text, () => {})
      expect(read.keys?.map((k) => k.id)).toEqual(['cccccccc'])
      expect(read.openKeys?.map((k) => k.id)).toEqual(['cccccccc'])
      const listed = credentialsReport('clash-key.json', () => text, new UsedCredentials()).credentials ?? []
      expect(listed.map((c) => [c.id, c.publicKey ?? 'verifier'])).toEqual([...full.map((f) => [f.id, 'verifier']), ['cccccccc', fine.text]])
    }
  })

  it('is not a reason to drop a key entry of that id when no verifier entry has it (a refused verifier entry does not count)', () => {
    const hub = hubKeys()
    const text = JSON.stringify({ v: 2, key: KEY, port: null, full: [{ id: HUB_ID, verifier: 'not hex' }], keys: [keyEntry(HUB_ID, hub.text)] })
    expect(readCredentialFile('lone-key.json', () => text, () => {}).keys?.map((k) => k.id)).toEqual([HUB_ID])
  })
})

/*
 * As for a full credential (#1405 review): while the file stays refused, a new key hello names no entry at once, and a
 * socket already in keeps the key entries the file named last, for at most LAST_READ_KEPT_MS
 */
it('keeps the last key entries for sockets in while the file is refused, and none for a new hello', () => {
  const hub = hubKeys()
  let t = 1_000
  let text: string | null = JSON.stringify({ v: 2, key: KEY, port: null, full: [], keys: [keyEntry(HUB_ID, hub.text)] })
  const read = () => {
    if (text === null) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return text
  }
  readCredentialFile('kept-keys.json', read, () => {}, () => t)
  text = null
  t += 1_000
  const refused = readCredentialFile('kept-keys.json', read, () => {}, () => t)
  expect(refused).toMatchObject({ keys: [], openKeys: [expect.objectContaining({ id: HUB_ID, publicKey: hub.text })] })
  t += 10_000
  expect(readCredentialFile('kept-keys.json', read, () => {}, () => t)).toMatchObject({ keys: [], openKeys: [] })
})

// §4.4: a key entry used here is still listed only under its id and its public key; another key under that id is another entry
it('lists a used key entry as gone once its id is listed under another public key', () => {
  const [first, second] = [hubKeys().text, hubKeys().text]
  const used = new UsedCredentials()
  used.saw(keyEntry(HUB_ID, first))
  expect(used.gone([{ ...keyEntry(HUB_ID, first), replaced: false }])).toEqual([])
  expect(used.gone([{ ...keyEntry(HUB_ID, second), replaced: true }])).toEqual([expect.objectContaining({ id: HUB_ID, gone: true, publicKey: first })])
})

// M1 of the #1717 review: whatever a key entry carries, a socket in under it is recorded, so its removal is listed as gone
describe('a key entry used for a full hello is always recorded (#1717 review, M1)', () => {
  it.each(['handover', 'pair-key', 'window', ''])('lists it as gone once removed, whatever its via (%j)', async (via) => {
    const hub = hubKeys()
    const entry = { id: HUB_ID, label: LABEL, publicKey: hub.text, created: 1, via }
    const { port, write, text, used, calls } = await serveHost({ keys: [entry] })
    const d = await hubDial(port, hub)
    expect(await accepted(d.p)).toBe(true)
    expect((await d.p.call('host.sessions'))?.ok).toBe(true)
    expect(calls.at(-1)?.ctx?.rights).toBe('full')
    // Listed while it is there, with no via of its own
    expect(credentialsReport('link-proof.json', text, used).credentials).toEqual([expect.objectContaining({ id: HUB_ID, publicKey: hub.text })])
    // Removed before any read of the hub: still told of, as gone, with its public key
    write({})
    const report = credentialsReport('link-proof.json', text, used)
    expect(report.credentials).toEqual([expect.objectContaining({ id: HUB_ID, label: LABEL, gone: true, publicKey: hub.text })])
    expect(report.usedUnderHubLabels).toEqual([expect.objectContaining({ id: HUB_ID, publicKey: hub.text })])
  })

  it('still leaves an older launcher’s one-call verifier entry out, which only a limited hello ever uses', () => {
    const used = new UsedCredentials()
    used.saw({ id: 'eeeeeeee', label: 'handover', verifier: verifierOf('h'.repeat(43)), created: 1, replaced: false, via: 'handover' })
    expect(used.gone([])).toEqual([])
  })
})

// #1711, with the #1717 review: a key hello is recorded as a hub's key entry and told to the hubs linked, with its public key
describe('a key hello is told to the hubs (#1712, #1711)', () => {
  it('records it with its public key and tells the hubs linked at once, with no nonce or check, also those in by key', async () => {
    const [one, two] = [hubKeys(), hubKeys()]
    const { port, told } = await serveHost({ keys: [keyEntry(HUB_ID, one.text), keyEntry('bbbbbbbb', two.text, 'hub:other-89abcdef')] })
    const first = await hubDial(port, one)
    expect(await accepted(first.p)).toBe(true)
    expect(told).toEqual([{ type: 'host_credential_used', credential: { id: HUB_ID, label: LABEL, created: 1, replaced: false, publicKey: one.text } }])
    // The first hub, linked by key, is told when the second says hello (it was told its own use too, in the replay of its hello)
    const second = await hubDial(port, two, { keyId: 'bbbbbbbb' })
    expect(await accepted(second.p)).toBe(true)
    const used = (p: Awaited<ReturnType<typeof peer>>) => p.frames.filter((f) => f.kind === 'event').map((f) => (f.event as { credential: { id: string } }).credential.id)
    expect(await first.p.wait(() => used(first.p).includes('bbbbbbbb'))).toBe(true)
    expect(first.p.frames.find((f) => f.kind === 'event' && (f.event as { credential: { id: string } }).credential.id === 'bbbbbbbb')).toMatchObject({ event: { type: 'host_credential_used', credential: { publicKey: two.text } } })
    expect(JSON.stringify(told)).not.toContain('"check"')
  })
})

describe('a socket in by key (§4.4)', () => {
  it('is closed once no entry with its id and its public key is listed: the key changed under the same id, or the entry went', async () => {
    const hub = hubKeys()
    const { port, write } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] }, { credentialSweepMs: 20 })
    const d = await hubDial(port, hub)
    expect(await accepted(d.p)).toBe(true)
    write({ keys: [keyEntry(HUB_ID, hubKeys().text)] })
    expect(await d.p.closed).toBe(4001)
    expect(d.p.reason()).toBe('credential withdrawn')
    // And a verifier entry under the same id keeps nothing open either
    write({ keys: [keyEntry(HUB_ID, hub.text)] })
    const again = await hubDial(port, hub)
    expect(await accepted(again.p)).toBe(true)
    write({ full: [{ id: HUB_ID, label: LABEL, verifier: verifierOf('x'.repeat(43)), created: 1 }] })
    expect(await again.p.closed).toBe(4001)
  })

  it('stays while its entry is listed', async () => {
    const hub = hubKeys()
    const { port, write } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] }, { credentialSweepMs: 20 })
    const d = await hubDial(port, hub)
    expect(await accepted(d.p)).toBe(true)
    write({ keys: [keyEntry(HUB_ID, hub.text), keyEntry('bbbbbbbb', hubKeys().text, 'hub:other')] })
    await new Promise((r) => setTimeout(r, 150))
    expect(d.p.code()).toBeNull()
    expect((await d.p.call('host.sessions'))?.ok).toBe(true)
  })
})

describe('the address a host behind a front door signs (§4.3)', () => {
  it("signs the door's port from CC_FRONT_DOOR, so a transcript of the socket's inner port does not verify", async () => {
    const hub = hubKeys()
    const door = 4100
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] }, { frontDoor: `ws://127.0.0.1:${door}` })
    const atDoor = await hubDial(port, hub, { address: linkAddress(door)! })
    expect(atDoor.hostSigned).toBe(true)
    expect(await accepted(atDoor.p)).toBe(true)
    const inner = await hubDial(port, hub)
    expect(inner.hostSigned).toBe(false)
    expect(await inner.p.closed).toBe(4001)
  })

  it('gives no key path for a door of another form', async () => {
    const hub = hubKeys()
    const { port } = await serveHost({ keys: [keyEntry(HUB_ID, hub.text)] }, { frontDoor: 'ws://localhost:4100' })
    // Malformed, for an id naming no entry too: no address to sign is not a credential withdrawn
    for (const key of [HUB_ID, 'cccccccc']) {
      const p = await peer(port)
      p.send({ kind: 'prove', nonce: proofNonce(), key })
      expect(await p.closed).toBe(4001)
      expect(p.reason(), key).toBe('not a hello')
      expect(p.frames).toEqual([])
    }
  })
})

/*
 * §10 "Impersonation": a same-user program reads the whole serve.json, stops the host, listens on its port with the host
 * key it derives, and answers the hub. It can stand in for the host (§2), but nothing it holds or receives opens the real
 * host once that runs again. On the verifier path the same squatter received the hub's full credential (§1)
 */
describe('a squatter on the port gets nothing it can use at the real host', () => {
  it('answers the hub with the derived key, receives its signature, and is refused with every value it holds', async () => {
    const hub = hubKeys()
    const file = { v: 2, key: KEY, port: null, full: [], keys: [keyEntry(HUB_ID, hub.text)] }
    // The squatter: a host of its own on the port, holding what the file gives it, so it signs as the real host would
    const derived = hostLinkKey(file.key)
    const { port } = await serveHost({ keys: file.keys })
    // The hub takes it for the host (the line's hostKey is the derived one) and sends its hello, which the squatter keeps
    const dial = await hubDial(port, hub)
    expect(dial.hostSigned).toBe(true)
    expect(dial.proof?.hostKey).toBe(derived.publicKey.text)
    expect(await accepted(dial.p)).toBe(true)
    const stolen = dial.helloFrame as { token: string; auth: { key: string; sig: string } }
    const ownNonce = dial.proof!.hostNonce!
    expect(stolen.token).toBe(LINK_AUTH_MARKER)
    dial.p.ws.close()
    await server?.close()
    server = null

    // The real host again, on the same port with the same file
    const { port: real } = await serveHost({ keys: file.keys }, { port })
    expect(real).toBe(port)
    // Its hello replayed after a prove of its own (the real host draws another nonce), and with no prove
    const replay = await peer(port)
    replay.send({ kind: 'prove', nonce: dial.nonce, key: HUB_ID })
    expect(await replay.next('proof')).not.toBeNull()
    replay.send(stolen)
    expect(await replay.closed).toBe(4001)
    // Every string of the file and every value it received, as the token of a hello, and as an auth's signature
    const values = [file.key, hub.text, HUB_ID, LABEL, derived.publicKey.text, stolen.auth.sig, ownNonce, dial.nonce, LINK_AUTH_MARKER]
    for (const v of values) {
      const p = await peer(port)
      p.send({ kind: 'prove', nonce: proofNonce(), key: HUB_ID })
      await p.next('proof')
      p.send({ kind: 'hello', token: v, protocolVersion: PROTOCOL_VERSION, auth: { key: HUB_ID, sig: stolen.auth.sig } })
      expect(await p.closed, v).toBe(4001)
    }
    // What the file gives is the limited credential, which it had anyway: everyday calls, never full
    const lim = await peer(port)
    lim.send({ kind: 'hello', token: limitedToken(file.key), protocolVersion: PROTOCOL_VERSION })
    expect(await lim.next('hello_ok')).not.toBeNull()
    expect((await lim.call('host.sessions'))?.ok).toBe(false)
  })
})

describe('the hand-over call takes limited rights (§4.4)', () => {
  it('lets the limited credential say host.handover, and takes an older launcher’s hand-over credential as limited, never full', async () => {
    expect(limitedRefusal('host.handover', { handover: null })).toBeNull()
    const handover = 'h'.repeat(43)
    const { port, calls } = await serveHost({ full: [{ id: 'eeeeeeee', label: 'handover', verifier: verifierOf(handover), created: 1, via: 'handover' }] })
    const p = await peer(port)
    p.send({ kind: 'hello', token: handover, protocolVersion: PROTOCOL_VERSION })
    expect(await p.next('hello_ok')).not.toBeNull()
    expect((await p.call('host.handover'))?.ok).toBe(true)
    expect(calls.at(-1)).toMatchObject({ method: 'host.handover', ctx: { rights: 'limited' } })
    expect((await p.call('host.sessions'))?.ok).toBe(false)
  })
})
