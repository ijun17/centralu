import { afterEach, describe, expect, it } from 'vitest'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import type { AgentSpawnSpec } from '../contract.js'
import { agyHome, browserFolder, sessionTemp } from './agent-files.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { AGY_RELEASE } from './release.js'
import { runSignIn } from './sign-in.js'
import { driven, fakeInstall, fakeSignIn, folder, HOST_TEST_ARCHIVE, HOST_TEST_PLATFORM, inFolder, leftovers, pathIn, sessionOpts, tempData, TEST_ARCHIVE, write } from './agent-files.test-helpers.js'

/**
 * The agent's TEMP on Windows: 1.4.3 unpacks itself there on every start (337 MB) and leaves it when killed, so it is a
 * folder of Centralu's: a session's own across its processes, any other process's gone with it. The agent is a scripted
 * peer that unpacks a stand-in where its TEMP says, as the real one does
 */

const WINDOWS = AGY_RELEASE.archives['windows-x86_64']

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

function temp() {
  const t = tempData()
  data.push(t)
  return t
}

/** A process that unpacks itself into its TEMP, as 1.4.3's does on start, and answers a session's calls; never outside `root` */
function unpacking(root: string, specs: AgentSpawnSpec[], peers: FakeAcpPeer[]) {
  const script: PeerScript = async (method) => {
    if (method === 'initialize') return { result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }
    if (method === 'session/new') return { result: { sessionId: 'ses-t' } }
    if (method === 'session/load') return { result: {} }
    if (method === 'session/prompt') return { result: { stopReason: 'end_turn' } }
    return { result: null }
  }
  return (spec: AgentSpawnSpec) => {
    specs.push(spec)
    if (!String(spec.env?.TEMP).startsWith(root)) throw new Error(`TEMP is not under the test's data folder: ${spec.env?.TEMP}`)
    const unpacked = pathIn(String(spec.env?.TEMP), `_MEI${specs.length}`)
    folder(unpacked)
    write(pathIn(unpacked, 'agy_acp_licenses.txt'), 'stand-in')
    const p = new FakeAcpPeer(script)
    peers.push(p)
    return p
  }
}

describe("the agent's TEMP", () => {
  it("is a session's own across its processes: what the agent keeps there outlasts a sleep, what it unpacked does not", async () => {
    const t = temp()
    fakeInstall(t.home, WINDOWS)
    fakeSignIn(t.home)
    const specs: AgentSpawnSpec[] = []
    const peers: FakeAcpPeer[] = []
    const profile = antigravityProfile({ dataDir: t.dir, platform: 'win32', arch: 'x64' })
    const adapter = new AntigravityAdapter(profile, unpacking(t.dir, specs, peers))
    const w = driven()
    const first = await adapter.createSession(sessionOpts('agy-t1'), w.emit)
    const env = specs[0]!.env ?? {}
    expect(env.TEMP).toBe(sessionTemp(t.home, 'agy-t1'))
    expect([env.TMP, env.TMPDIR]).toEqual([env.TEMP, env.TEMP])
    write(pathIn(String(env.TEMP), 'daemon.sock'), 'a command kept this for a later turn')
    // Asleep: the host disposes the handle once its process is gone (here killed, as on Windows), and wakes it in a new one
    peers[0]!.exit(null, 'SIGKILL')
    await w.event((e) => e.type === 'session_live' && !e.live)
    await first.dispose()
    expect(inFolder(String(env.TEMP))).toEqual(['daemon.sock'])
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
    // An unpack the end could not remove (a tree that still held it) goes at the session's next start
    folder(pathIn(String(env.TEMP), '_MEI-held'))
    const next = await adapter.createSession(sessionOpts('agy-t1', 'normal', { resumeExternalId: 'ses-t' }), w.emit)
    expect(specs[1]!.env?.TEMP).toBe(env.TEMP)
    expect(inFolder(String(env.TEMP)).sort()).toEqual(['_MEI2', 'daemon.sock'])
    await next.dispose()
    expect(inFolder(String(env.TEMP))).toEqual(['daemon.sock'])
  })

  it("keeps a later process's unpack from an earlier handle's later end", async () => {
    const t = temp()
    fakeInstall(t.home, WINDOWS)
    fakeSignIn(t.home)
    const specs: AgentSpawnSpec[] = []
    const adapter = new AntigravityAdapter(antigravityProfile({ dataDir: t.dir, platform: 'win32', arch: 'x64' }), unpacking(t.dir, specs, []))
    const earlier = await adapter.createSession(sessionOpts('agy-t4'), driven().emit)
    // The host lets go of a handle and disposes it without waiting (a crash, an app agent's end), and the next message starts another
    const later = await adapter.createSession(sessionOpts('agy-t4', 'normal', { resumeExternalId: 'ses-t' }), driven().emit)
    await earlier.dispose()
    expect(inFolder(sessionTemp(t.home, 'agy-t4'))).toEqual(['_MEI2'])
    await later.dispose()
    expect(inFolder(sessionTemp(t.home, 'agy-t4'))).toEqual([])
  })

  it("goes when the session is deleted for good, and only then (the host's sweep)", async () => {
    const t = temp()
    const adapter = new AntigravityAdapter(antigravityProfile({ dataDir: t.dir, platform: 'win32', arch: 'x64' }))
    for (const id of ['live', 'deleted']) {
      folder(sessionTemp(t.home, id))
      write(pathIn(sessionTemp(t.home, id), 'kept.txt'), id)
    }
    await adapter.sweepSessionFiles?.((id) => id === 'live')
    expect(inFolder(pathIn(t.home.root, 'tmp'))).toEqual(['live'])
  })

  it("is the sign-in's own folder's tmp/ too, gone when the sign-in ends", async () => {
    const t = temp()
    const specs: AgentSpawnSpec[] = []
    const failing = unpacking(t.dir, specs, [])
    await runSignIn(t.home, TEST_ARCHIVE, new AbortController().signal, {
      platform: 'win32',
      spawn: (spec) => {
        const p = failing(spec)
        // Not signed in: the sign-in ends with the agent's refusal, its process killed
        setImmediate(() => p.exit(null, 'SIGKILL'))
        return p
      },
    }).catch(() => {})
    expect(specs[0]!.env?.TEMP).toMatch(/[\\/]\.sign-in-[^\\/]+[\\/]tmp$/)
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
  })

  it.skipIf(process.platform === 'win32')("on macOS and Linux is the system's: a longer TMPDIR would put sockets made there past their limit", async () => {
    const t = temp()
    fakeInstall(t.home, HOST_TEST_ARCHIVE)
    fakeSignIn(t.home)
    const specs: AgentSpawnSpec[] = []
    const profile = antigravityProfile({ dataDir: t.dir, platform: HOST_TEST_PLATFORM, arch: 'x64' })
    const adapter = new AntigravityAdapter(profile, (spec) => (specs.push(spec), new FakeAcpPeer(async (m) => ({ result: m === 'session/new' ? { sessionId: 'ses-t' } : {} }))))
    const handle = await adapter.createSession(sessionOpts('agy-t2'), driven().emit)
    expect(specs[0]!.env?.TMPDIR).toBe(process.env.TMPDIR)
    expect(leftovers(t.home, '.sign-in-').flatMap((n) => inFolder(pathIn(t.home.root, n)))).not.toContain('tmp')
    await handle.dispose()
  })

  it("on Windows is refused past 118 characters with the session's id (1.4.3 unpacks into at most 122), saying so and leaving no folder", async () => {
    const t = temp()
    const id = 'agy-t3'
    // The data folder's length that makes a session's TEMP `length` characters long (one separator, one character). A
    // short id, as a session's 36 would leave no room under the system's temporary folder on macOS
    const tail = `/tools/antigravity/tmp/${id}`.length
    const at = (length: number) => {
      const pad = length - tail - t.dir.length - 1
      expect(pad).toBeGreaterThan(0)
      return agyHome(pathIn(t.dir, 'd'.repeat(pad)), AGY_RELEASE.version)
    }
    const fits = await browserFolder(at(118), 'win32', {}, id)
    expect(fits.temp).toBe(sessionTemp(at(118), id))
    expect(fits.temp).toHaveLength(118)
    expect(fits.browser).not.toBe('')
    await fits.remove()
    const long = at(119)
    const refused = await browserFolder(long, 'win32', {}, id)
    expect(refused.browser).toBe('')
    expect(refused.why).toMatch(/at most 118 characters \(it has 119\)\. Move Centralu's data folder to a shorter path\.$/)
    expect(leftovers(long, '.sign-in-')).toEqual([])
  })
})
