import { afterEach, describe, expect, it } from 'vitest'
import { AUTH_REQUIRED, RpcError } from '../acp/connection.js'
import { FakeAcpPeer } from '../acp/fake-peer.test-helpers.js'
import type { AgentSpawnSpec } from '../contract.js'
import { ReplayPeer, replaySpawner } from '../frames/replay.test-helpers.js'
import { InstallFailure } from './failure.js'
import { runSignIn, signInFailure, signInUrl } from './sign-in.js'
import { agyStderrLine } from './shape.js'
import { agyRecording, exists, fakeInstall, HOST_TEST_PLATFORM, inVersion, leftovers, TEST_ARCHIVE, tempData } from './agent-files.test-helpers.js'

/**
 * Antigravity's sign-in inside Centralu (docs/plans/antigravity-adapter.md §4): the recorded `authenticate` replayed, and
 * the parts a recording cannot hold (the address on stderr, a timeout, a cancel) with a scripted agent. No browser opens:
 * the opener is a stand-in that writes down what it was given.
 */

const ADDRESS = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2F&state=s'

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

function home() {
  const t = tempData()
  data.push(t)
  fakeInstall(t.home)
  return t.home
}

describe("Antigravity's sign-in", () => {
  it('runs initialize and authenticate in a process of its own, and says the plan the agent answered', async () => {
    const h = home()
    const rec = agyRecording('sign-in')
    const { spawn, state } = replaySpawner(rec)
    const specs: AgentSpawnSpec[] = []
    const opened: string[] = []
    const result = await runSignIn(h, TEST_ARCHIVE, new AbortController().signal, {
      platform: HOST_TEST_PLATFORM,
      openUrl: (u) => opened.push(u),
      spawn: (spec) => {
        specs.push(spec)
        const p = spawn(spec)
        // The agent prints its address on stderr as it waits (spike §4); the recording does not keep stderr
        setImmediate(() => p instanceof ReplayPeer && p.stderr.write(`I1027 server.py] Open the following link to authenticate the ACP server: ${ADDRESS}\n`))
        return p
      },
    })
    expect(state.problems).toEqual([])
    expect(state.left()).toBe(0)
    expect(result.plan).toEqual({ name: 'Antigravity Starter Quota', upgradeUri: expect.stringMatching(/^https:\/\/antigravity\.google\//) })
    // Isolated as every Antigravity process is, with the BROWSER helper in a folder of its own
    expect(specs[0]!.env).toMatchObject({ GEMINI_HOME: h.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1' })
    expect(specs[0]!.env?.BROWSER).toMatch(/[\\/]\.sign-in-[^\\/]+[\\/]open-url(\.mjs' %s)?$/)
    expect(specs[0]!.command).toBe(inVersion(h, TEST_ARCHIVE.command))
    expect(opened).toEqual([ADDRESS])
    // The helper's folder goes with the sign-in
    expect(leftovers(h, '.sign-in-')).toEqual([])
  })

  it('asks authenticate for a Google sign-in and waits; a cancel ends the process and says cancelled', async () => {
    const h = home()
    const abort = new AbortController()
    const peers: FakeAcpPeer[] = []
    const opened: string[] = []
    const run = runSignIn(h, TEST_ARCHIVE, abort.signal, {
      // On Windows too the host opens it, outside its job (review of #1685: the agent's own launcher opened it in the job)
      platform: 'win32',
      openUrl: (u) => opened.push(u),
      spawn: () => {
        const p = new FakeAcpPeer((method) => (method === 'initialize' ? { result: { protocolVersion: 1 } } : { hold: true }))
        peers.push(p)
        return p
      },
    })
    const auth = await new Promise<Record<string, unknown>>((resolve) => {
      const wait = () => (peers[0] ? void peers[0].next((m) => m.method === 'authenticate').then(resolve) : setImmediate(wait))
      wait()
    })
    expect(auth.params).toEqual({ methodId: 'oauth-personal' })
    peers[0]!.stderr.write(`Open the following link to authenticate the ACP server: ${ADDRESS}\n`)
    await new Promise((r) => setImmediate(r))
    expect(opened).toEqual([ADDRESS])
    abort.abort()
    const failure = await run.then(
      () => null,
      (e: unknown) => e,
    )
    expect(failure).toBeInstanceOf(InstallFailure)
    expect((failure as InstallFailure).reason).toBe('cancelled')
    expect(peers[0]!.killed || peers[0]!.exitCode !== null).toBe(true)
  })

  it('opens only an https address on a Google host', () => {
    expect(signInUrl(ADDRESS)).toBe(ADDRESS)
    expect(signInUrl('http://accounts.google.com/x')).toBeNull()
    expect(signInUrl('https://accounts.google.com.evil.example/x')).toBeNull()
    expect(signInUrl('file:///etc/passwd')).toBeNull()
    expect(signInUrl('not a url')).toBeNull()
  })

  it('refuses an address with a user part or a port of its own, and passes on one rebuilt from its parts', () => {
    // The re-review of #1680: each of these was taken, with what stood before the `@` kept in what went on
    expect(signInUrl('https://evil.example@accounts.google.com/x')).toBeNull()
    expect(signInUrl('https://user%40mail.example@accounts.google.com/x')).toBeNull()
    expect(signInUrl('https://user:secret@accounts.google.com/x')).toBeNull()
    expect(signInUrl('https://accounts.google.com:8443/x')).toBeNull()
    // Rebuilt: the host as parsed (lower case), the path, query and fragment, nothing else of the agent's string
    expect(signInUrl(' https://ACCOUNTS.google.com/a/b?c=d#e ')).toBe('https://accounts.google.com/a/b?c=d#e')
    expect(signInUrl('https://accounts.google.com\\@evil.example/x')).toBe('https://accounts.google.com/@evil.example/x')
  })

  it('says why a sign-in ended, as a word the line can act on', () => {
    const live = new AbortController().signal
    const aborted = AbortSignal.abort()
    expect(signInFailure(new RpcError(-32603, 'Timed out waiting for the authentication flow to complete.'), live).reason).toBe('timed_out')
    expect(signInFailure(new Error('No response for authenticate'), live).reason).toBe('timed_out')
    expect(signInFailure(new Error('request cancelled while closing'), aborted).reason).toBe('cancelled')
    expect(signInFailure(new Error('Antigravity exited'), live).reason).toBe('failed')
  })

  it("maps only the authenticate call's own timeout to the five minutes; another timeout keeps its reason", () => {
    const live = new AbortController().signal
    const network = signInFailure(new RpcError(-32603, 'Request to cloudcode-pa timed out after 30s'), live)
    expect(network.reason).toBe('failed')
    expect(network.message).toContain('timed out after 30s')
    expect(signInFailure(new Error('No response for initialize'), live).reason).toBe('failed')
    // Only the whole message: another call's name after it, or a bound of its own, is not Centralu's authenticate bound
    expect(signInFailure(new Error('No response for authenticate within 300000ms'), live).reason).toBe('failed')
    expect(signInFailure(new Error('No response for authenticateDevice'), live).reason).toBe('failed')
    expect(signInFailure(new Error('connect ETIMEDOUT: timed out'), live).reason).toBe('failed')
  })

  // The two answers 1.4.3 gave (deep review of #1680, raw captures): the same code and reason, told apart by their words
  const TIMED_OUT = new RpcError(AUTH_REQUIRED, 'Onboarding failed: Timed out waiting for the authentication flow to complete.', { reason: 'onboarding_failed' })
  const VERIFY = 'https://accounts.google.com/v3/signin/continue?flow=example'
  const INELIGIBLE = new RpcError(
    AUTH_REQUIRED,
    `Onboarding failed: User is ineligible for free-tier. Reason: Your current account is not eligible for Antigravity. Verify your account to continue.\n\nAlternatively, try signing in with another personal Google account.. Verification URL: ${VERIFY}`,
    { reason: 'onboarding_failed' },
  )

  it('tells a sign-in that timed out from an account Google will not serve, though both say onboarding_failed', () => {
    const live = new AbortController().signal
    expect(signInFailure(TIMED_OUT, live).reason).toBe('timed_out')
    const ineligible = signInFailure(INELIGIBLE, live)
    expect(ineligible.reason).toBe('ineligible')
    // The verification page is carried apart for the screen, never in the words
    expect(ineligible.verifyUri).toBe(VERIFY)
    expect(ineligible.message).not.toContain('https://')
  })

  it('carries a verification page only when it is https on a Google host, and no address in a failure\'s words', () => {
    const live = new AbortController().signal
    const elsewhere = new RpcError(AUTH_REQUIRED, 'Onboarding failed: User is ineligible. Verification URL: https://accounts.google.com.evil.example/x', { reason: 'onboarding_failed' })
    expect(signInFailure(elsewhere, live).verifyUri).toBeUndefined()
    const other = signInFailure(new RpcError(-32603, 'Failed for someone@example.com, see https://example.com/help'), live)
    expect(other.reason).toBe('failed')
    expect(other.message).not.toMatch(/https:|someone@/)
  })

  it("keeps the agent's address, its account's email and its token lines out of host.log", () => {
    expect(agyStderrLine(`Open the following link to authenticate the ACP server: ${ADDRESS}`)).toBeNull()
    // Each rule on its own: a line with only an address, only an email, only a token word
    expect(agyStderrLine('Opening https://example.com/plain')).toBeNull()
    expect(agyStderrLine('Account someone@example.com chosen')).toBeNull()
    expect(agyStderrLine('refreshed the token')).toBeNull()
    expect(agyStderrLine("loadCodeAssist response: {'upgradeSubscriptionUri': 'x'}")).toBeNull()
    expect(agyStderrLine('AccountChooser for someone@example.com')).toBeNull()
    expect(agyStderrLine('credential_store.py:235] using file credential storage.')).toBe('credential_store.py:235] using file credential storage.')
  })

  it('leaves no helper folder when the process cannot start', async () => {
    const h = home()
    const failure = await runSignIn(h, TEST_ARCHIVE, new AbortController().signal, {
      platform: HOST_TEST_PLATFORM,
      openUrl: () => {},
      spawn: () => {
        const p = new FakeAcpPeer(() => ({ hold: true }))
        setImmediate(() => p.exit(1))
        return p
      },
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((failure as InstallFailure).reason).toBe('failed')
    expect(leftovers(h, '.sign-in-')).toEqual([])
    expect(exists(h.geminiHome)).toBe(false)
  })
})
