import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { FakeAcpPeer, type PeerScript } from '../acp/fake-peer.test-helpers.js'
import type { AgentSpawnSpec } from '../contract.js'
import { agyHome, browserFolder, windowsBrowserCommand } from './agent-files.js'
import { InstallFailure } from './failure.js'
import { AntigravityAdapter, antigravityProfile } from './index.js'
import { AGY_RELEASE } from './release.js'
import { agentSignInUrl, googleAuthorizeUrl, runSignIn } from './sign-in.js'
import { driven, fakeInstall, fakeSignIn, HOST_TEST_ARCHIVE, HOST_TEST_PLATFORM, leftovers, runBrowser, sessionOpts, tempData, TEST_ARCHIVE } from './agent-files.test-helpers.js'

/**
 * The agent's browser (review of #1685): every Antigravity process gets its own `BROWSER` helper, so the agent never opens
 * a browser itself, on any OS, and the person's own `BROWSER` never reaches it. In a sign-in the host opens the address the
 * helper hands over; in a session the helper running means the stored sign-in stopped working, and the session fails as
 * not signed in at once rather than waiting on a browser nobody asked for.
 *
 * The helper is the real one, run the way the agent's launcher (CPython's `webbrowser`) runs it (`runBrowser`); the agent
 * is a scripted peer, as no recording holds a sign-in that stopped working.
 */

/**
 * The agent's own login request, as 1.4.3 hands it to `BROWSER` (measured on Windows; the state and the PKCE challenge
 * stand in). With `&` in it: a batch file would have handed it to `cmd`, which splits it there
 */
const ADDRESS = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${AGY_RELEASE.oauthClient}&redirect_uri=http%3A%2F%2F127.0.0.1%3A60382%2F&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&state=s&code_challenge=c&code_challenge_method=S256&access_type=offline&prompt=consent`

/** What `gcloud auth login` opens (deep review of #1687): Google's authorize page, with gcloud's own public client */
const GCLOUD = 'https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid'
/** A page a script the agent runs may open */
const DOC = 'https://docs.google.com/document/d/abc/edit'

const data: { done(): void }[] = []
const saved = process.env.BROWSER
afterEach(() => {
  for (const d of data.splice(0)) d.done()
  if (saved === undefined) delete process.env.BROWSER
  else process.env.BROWSER = saved
})

function temp() {
  const t = tempData()
  data.push(t)
  return t
}

/** What the helper hands over, once it has */
function handedOver(folder: { watch(found: (text: string) => void): void }): Promise<string> {
  return new Promise((resolve) => folder.watch(resolve))
}

describe("the BROWSER helper's folder", () => {
  it("on Windows is node and a script, which takes an address with & in it whole and exits 0 (so the launcher opens nothing itself)", async () => {
    const t = temp()
    const folder = await browserFolder(t.home, 'win32')
    expect(folder.browser).toMatch(/^'.+' '.+[\\/]\.sign-in-[^\\/]+[\\/]open-url\.mjs' %s$/)
    const got = handedOver(folder)
    expect(await runBrowser(folder.browser, ADDRESS)).toBe(0)
    expect(await got).toBe(ADDRESS)
    await folder.remove()
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('on macOS and Linux is a sh script, BROWSER its path', async () => {
    const t = temp()
    const folder = await browserFolder(t.home, HOST_TEST_PLATFORM)
    expect(folder.browser).toMatch(/[\\/]\.sign-in-[^\\/]+[\\/]open-url$/)
    const got = handedOver(folder)
    expect(await runBrowser(folder.browser, ADDRESS)).toBe(0)
    expect(await got).toBe(ADDRESS)
    await folder.remove()
  })

  it('hands each address over once: a later watch on the same folder is not told of it', async () => {
    const t = temp()
    const folder = await browserFolder(t.home, 'win32')
    const first = handedOver(folder)
    await runBrowser(folder.browser, ADDRESS)
    await first
    const later: string[] = []
    folder.watch((text) => later.push(text))
    await new Promise((r) => setTimeout(r, 200))
    expect(later).toEqual([])
    await folder.remove()
  })

  it("takes only the agent's own login request: its client, Google's v2 authorize page, a loopback redirect", () => {
    expect(agentSignInUrl(ADDRESS)).toBe(ADDRESS)
    expect(agentSignInUrl(ADDRESS.replace('127.0.0.1', 'localhost'))).toBe(ADDRESS.replace('127.0.0.1', 'localhost'))
    expect(agentSignInUrl(GCLOUD)).toBeNull()
    expect(agentSignInUrl(GCLOUD.replace('/o/oauth2/auth', '/o/oauth2/v2/auth'))).toBeNull()
    expect(agentSignInUrl(DOC)).toBeNull()
    // Each part on its own: the client named twice, another redirect, another host or path, no code flow, not https
    expect(agentSignInUrl(`${ADDRESS}&client_id=32555940559.apps.googleusercontent.com`)).toBeNull()
    expect(agentSignInUrl(ADDRESS.replace('http%3A%2F%2F127.0.0.1%3A60382', 'https%3A%2F%2Fevil.example'))).toBeNull()
    // http, as the agent's own: only the loopback check refuses these (RV1687b), a host elsewhere or one that only starts
    // or ends like the loopback
    for (const back of ['http://evil.example/cb', 'http://localhost.evil.test/cb', 'http://127.0.0.1.nip.io/cb', 'http://evil.localhost.example:60382/']) {
      expect(agentSignInUrl(ADDRESS.replace('http%3A%2F%2F127.0.0.1%3A60382%2F', encodeURIComponent(back))), back).toBeNull()
    }
    // The loopback in each spelling the agent may use is still its own
    for (const back of ['http://localhost:60382/', 'http://[::1]:60382/']) {
      expect(agentSignInUrl(ADDRESS.replace('http%3A%2F%2F127.0.0.1%3A60382%2F', encodeURIComponent(back))), back).not.toBeNull()
    }
    expect(agentSignInUrl(ADDRESS.replace('http%3A%2F%2F127.0.0.1', 'http%3A%2F%2Fuser%40127.0.0.1'))).toBeNull()
    expect(agentSignInUrl(ADDRESS.replace('accounts.google.com', 'myaccount.google.com'))).toBeNull()
    expect(agentSignInUrl(ADDRESS.replace('/o/oauth2/v2/auth', '/o/oauth2/v2/authx'))).toBeNull()
    expect(agentSignInUrl(ADDRESS.replace('response_type=code', 'response_type=token'))).toBeNull()
    expect(agentSignInUrl(ADDRESS.replace('https:', 'http:'))).toBeNull()
    // Told apart in the log only: Google's v2 authorize page with another client (a new release's, not measured)
    expect(googleAuthorizeUrl(ADDRESS.replace(AGY_RELEASE.oauthClient, 'other.apps.googleusercontent.com'))).not.toBeNull()
    expect(googleAuthorizeUrl(GCLOUD)).toBeNull()
    expect(googleAuthorizeUrl(DOC)).toBeNull()
  })

  it('is no command where a path holds the separator the launcher splits BROWSER at, or %s', () => {
    expect(windowsBrowserCommand('C:\\node\\node.exe', "C:\\Users\\o'neil\\x\\open-url.mjs")).toBe(`'C:\\node\\node.exe' 'C:\\Users\\o'\\''neil\\x\\open-url.mjs' %s`)
    expect(windowsBrowserCommand('C:\\a;b\\node.exe', 'C:\\x\\open-url.mjs')).toBe('')
    expect(windowsBrowserCommand('C:\\node\\node.exe', 'C:\\%s\\open-url.mjs')).toBe('')
  })
})

describe("the sign-in's browser", () => {
  it("on Windows: the agent gets Centralu's helper, never the person's BROWSER, and the host opens what it hands over", async () => {
    const t = temp()
    fakeInstall(t.home)
    process.env.BROWSER = 'person-browser'
    const specs: AgentSpawnSpec[] = []
    const opened: string[] = []
    let browserOpened = () => {}
    const signedIn = new Promise<void>((resolve) => (browserOpened = resolve))
    const script: PeerScript = async (method) => {
      if (method === 'initialize') return { result: { protocolVersion: 1 } }
      if (method === 'authenticate') {
        // As the agent's launcher does with the address (it prints it on stderr too; left out here, so only the helper tells),
        // then answers once the person has signed in in the browser the host opened. An address another process wrote
        // into the folder first (an agent of another session can write under the data folder) is not opened
        expect(await runBrowser(String(specs[0]!.env?.BROWSER), GCLOUD)).toBe(0)
        expect(await runBrowser(String(specs[0]!.env?.BROWSER), ADDRESS)).toBe(0)
        await signedIn
        return { result: {} }
      }
      return { result: null }
    }
    await runSignIn(t.home, TEST_ARCHIVE, new AbortController().signal, {
      platform: 'win32',
      openUrl: (u) => {
        opened.push(u)
        browserOpened()
      },
      spawn: (spec) => {
        specs.push(spec)
        return new FakeAcpPeer(script)
      },
    })
    expect(specs[0]!.env?.BROWSER).not.toBe('person-browser')
    expect(specs[0]!.env?.BROWSER).toMatch(/open-url\.mjs' %s$/)
    expect(opened).toEqual([ADDRESS])
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
  })
})

const SID = 'ses-b'
const INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'antigravity-acp', version: '1.4.3' } }

/**
 * A session on this machine's platform, so the helper is the one this OS runs; `wants` is the method in which the agent
 * starts its own browser login (it runs the helper and waits, as 1.4.3 does with a token whose refresh fails or `{}`)
 */
function world(wants: 'session/new' | 'session/load' | 'session/prompt' | readonly string[], address: string = ADDRESS) {
  const asks: readonly string[] = typeof wants === 'string' ? [wants] : wants
  const t = temp()
  fakeInstall(t.home, HOST_TEST_ARCHIVE)
  fakeSignIn(t.home)
  process.env.BROWSER = 'person-browser'
  const peers: FakeAcpPeer[] = []
  const specs: AgentSpawnSpec[] = []
  const opened: string[] = []
  const script: PeerScript = async (method) => {
    if (asks.includes(method)) {
      await runBrowser(String(specs.at(-1)!.env?.BROWSER), address)
      return method === 'session/prompt' && address !== ADDRESS ? { result: { stopReason: 'end_turn' } } : { hold: true }
    }
    if (method === 'initialize') return { result: INIT }
    if (method === 'session/new') return { result: { sessionId: SID } }
    if (method === 'session/load') return { result: {} }
    return { result: null }
  }
  const profile = antigravityProfile({ dataDir: t.dir, platform: HOST_TEST_PLATFORM, arch: 'x64', signIn: { openUrl: (u) => opened.push(u) } })
  const adapter = new AntigravityAdapter(profile, (spec) => {
    specs.push(spec)
    const p = new FakeAcpPeer(script)
    peers.push(p)
    return p
  })
  return { adapter, peers, specs, opened, home: t.home, ...driven() }
}

const notLoggedIn = (e: NormalizedEvent) => e.type === 'error' && e.error.code === 'not_logged_in'

describe('a stored sign-in that stopped working, in a session', () => {
  it('session/new: the agent starting its own browser login fails the start as not signed in at once, and the line offers Sign in', async () => {
    const w = world('session/new')
    expect(w.adapter.setup.current().state).toBe('ready')
    const started = Date.now()
    const err = await w.adapter.createSession(sessionOpts('agy-b1'), w.emit).then(
      () => null,
      (e: unknown) => e,
    )
    expect(Reflect.get(Object(err), 'code')).toBe('not_logged_in')
    // Not the two minutes of `session/new`'s bound
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(w.adapter.setup.current().state).toBe('signed_out')
    // The process waiting on the browser is ended, no browser was opened for it, and the person's BROWSER did not reach it
    expect(w.peers[0]!.killed || w.peers[0]!.exitCode !== null).toBe(true)
    expect(w.opened).toEqual([])
    expect(w.specs[0]!.env?.BROWSER).not.toBe('person-browser')
    expect(leftovers(w.home, '.sign-in-')).toEqual([])
  })

  it('session/load (a resume): the same', async () => {
    const w = world('session/load')
    const err = await w.adapter.createSession(sessionOpts('agy-b2', 'normal', { resumeExternalId: 'conv-1' }), w.emit).then(
      () => null,
      (e: unknown) => e,
    )
    expect(Reflect.get(Object(err), 'code')).toBe('not_logged_in')
    expect(w.adapter.setup.current().state).toBe('signed_out')
    expect(w.opened).toEqual([])
  })

  it('a prompt whose token runs out mid-session: the turn fails as not signed in, and the process waiting on the browser is ended', async () => {
    const w = world('session/prompt')
    const handle = await w.adapter.createSession(sessionOpts('agy-b3'), w.emit)
    handle.send('go')
    const failed = await w.event(notLoggedIn)
    expect(failed).toMatchObject({ error: { code: 'not_logged_in', retryable: false } })
    expect(w.adapter.setup.current().state).toBe('signed_out')
    // Ended here, so it sleeps: the next message starts a new process, which asks for the sign-in again if still needed
    await w.event((e) => e.type === 'session_live' && e.live === false)
    expect(w.peers[0]!.killed || w.peers[0]!.exitCode !== null).toBe(true)
    expect(w.events.some((e) => e.type === 'error' && e.error.code === 'adapter_crashed')).toBe(false)
    expect(w.opened).toEqual([])
    await handle.dispose()
    expect(leftovers(w.home, '.sign-in-')).toEqual([])
  })

  // Every command the agent runs inherits BROWSER (deep review of #1687): only the agent's own login request is a sign-in
  it.each([
    ['gcloud auth login', GCLOUD],
    ['a Google Doc', DOC],
    ['a page elsewhere', 'https://example.com/docs?a=1&b=2'],
  ])('an address a command opens (%s) is no sign-in: the turn goes on, and nothing is opened', async (_what, address) => {
    const w = world('session/prompt', address)
    const handle = await w.adapter.createSession(sessionOpts('agy-b5'), w.emit)
    handle.send('go')
    await w.event((e) => e.type === 'turn_complete' || e.type === 'error')
    // Time for a late watch to have fired
    await new Promise((r) => setTimeout(r, 300))
    expect(w.events.some((e) => e.type === 'turn_complete')).toBe(true)
    expect(w.events.some(notLoggedIn)).toBe(false)
    expect(w.adapter.setup.current().state).toBe('ready')
    expect(w.opened).toEqual([])
    await handle.dispose()
  })
})

/**
 * Where no helper can be written (a data folder holding `;` on Windows), the agent's launcher would start the browser itself,
 * inside the host's job on Windows, and a sign-in that stopped working would hang the start again: refused, not started
 */
describe('no BROWSER helper', () => {
  function noHelper() {
    const t = temp()
    const dataDir = `${t.dir}/data;x`
    const home = agyHome(dataDir, AGY_RELEASE.version)
    const archive = AGY_RELEASE.archives['windows-x86_64']
    fakeInstall(home, archive)
    fakeSignIn(home)
    const spawned: AgentSpawnSpec[] = []
    const spawn = (spec: AgentSpawnSpec) => {
      spawned.push(spec)
      return new FakeAcpPeer(() => ({ hold: true }))
    }
    return { dataDir, home, archive, spawned, spawn }
  }

  it('a session is refused before the agent starts, and leaves no folder', async () => {
    const n = noHelper()
    const adapter = new AntigravityAdapter(antigravityProfile({ dataDir: n.dataDir, platform: 'win32', arch: 'x64' }), n.spawn)
    const err = await adapter.createSession(sessionOpts('agy-nh'), driven().emit).then(
      () => null,
      (e: unknown) => e,
    )
    expect(String((err as Error).message)).toMatch(/cannot start here/)
    expect(n.spawned).toEqual([])
    expect(leftovers(n.home, '.sign-in-')).toEqual([])
  })

  it('a sign-in is refused before the agent starts, and opens nothing', async () => {
    const n = noHelper()
    const opened: string[] = []
    const err = await runSignIn(n.home, n.archive, new AbortController().signal, { platform: 'win32', openUrl: (u) => opened.push(u), spawn: n.spawn }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(InstallFailure)
    expect((err as InstallFailure).message).toMatch(/cannot sign in here/)
    expect(n.spawned).toEqual([])
    expect(opened).toEqual([])
    expect(leftovers(n.home, '.sign-in-')).toEqual([])
  })
})
