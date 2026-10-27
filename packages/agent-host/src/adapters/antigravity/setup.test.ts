import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolSetup, ToolSetupState } from '@cc/protocol'
import { InstallFailure } from './failure.js'
import { AGY_RELEASE } from './release.js'
import { ownerGone, ownerTag, browserFolder } from './agent-files.js'
import { AgySetup } from './setup.js'
import { endHosts, fakeInstall, fakeSignIn, folder, inRoot, leftovers, otherHost, TEST_ARCHIVE, tempData, write } from './agent-files.test-helpers.js'
import type { SignInResult } from './sign-in.js'

// The start-up cleanup, as slow as a busy Windows disk makes it (CI on 08be80ba1): every install and sign-in waits for it,
// so a test that steps the setup by counting ticks would act before the run it means to end had begun
vi.mock('./agent-files.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agent-files.js')>()
  return {
    ...real,
    removeLeftovers: async (...args: Parameters<typeof real.removeLeftovers>) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return real.removeLeftovers(...args)
    },
  }
})

/**
 * Antigravity's setup as a state machine (docs/plans/antigravity-adapter.md §3–§4), checked against a model of it: random
 * runs of what can happen (the person installs, cancels, signs in, a session finds the tool signed out; the install and
 * the sign-in end well or badly), each step compared with what the model says the line must show. Seeded, so a failing
 * run is the same run again (its seed is in the test's name).
 */

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

type Deferred = { resolve(): void; reject(e: unknown): void; promise: Promise<void> }
const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)))
  return { resolve, reject, promise }
}

/**
 * A stand-in for the install and the sign-in that end when the test says, and honour a cancel as the real ones do. Ready
 * once the host's start-up cleanup has ended (the event every install and sign-in waits on), so the steps below act on
 * runs that have begun
 */
async function world() {
  const t = tempData()
  data.push(t)
  let install: Deferred | null = null
  let signIn: Deferred | null = null
  const seen: ToolSetup[] = []
  const setup = new AgySetup({
    home: t.home,
    archive: TEST_ARCHIVE,
    version: AGY_RELEASE.version,
    runInstall: async (signal) => {
      install = deferred()
      signal.addEventListener('abort', () => install?.reject(new InstallFailure('cancelled', 'cancelled')))
      await install.promise
      fakeInstall(t.home)
    },
    runSignIn: async (signal): Promise<SignInResult> => {
      signIn = deferred()
      signal.addEventListener('abort', () => signIn?.reject(new InstallFailure('cancelled', 'cancelled')))
      await signIn.promise
      fakeSignIn(t.home)
      return { plan: { name: 'Starter' } }
    },
  })
  setup.onChange((s) => seen.push(s))
  await setup.whenTidy()
  return {
    setup,
    seen,
    finishInstall: (ok: boolean) => (ok ? install?.resolve() : install?.reject(new InstallFailure('network', 'down'))),
    finishSignIn: (how: 'ok' | 'timed_out' | 'ineligible') => (how === 'ok' ? signIn?.resolve() : signIn?.reject(new InstallFailure(how, how))),
  }
}

/** Lets every promise the step started settle (no clock, no disk: the stand-ins answer at once once told, and the cleanup has ended) */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

type Model = { installed: boolean; installing: boolean; signedIn: boolean; signingIn: boolean; failure: string | null }

function expected(m: Model): ToolSetupState {
  if (m.installing) return 'installing'
  if (!m.installed) return 'not_installed'
  if (m.signingIn) return 'signing_in'
  return m.signedIn ? 'ready' : 'signed_out'
}

const STEPS = ['install', 'cancelInstall', 'installOk', 'installFails', 'signIn', 'cancelSignIn', 'signInOk', 'signInTimesOut', 'ineligible', 'sessionSignedOut'] as const
type Step = (typeof STEPS)[number]

/** mulberry32: a small seeded generator, so a run can be repeated */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function step(w: Awaited<ReturnType<typeof world>>, m: Model, s: Step): Promise<void> {
  switch (s) {
    case 'install':
      w.setup.install()
      if (!m.installing && !m.installed) Object.assign(m, { installing: true, failure: null })
      break
    case 'cancelInstall':
      if (m.installing) Object.assign(m, { installing: false, failure: 'cancelled' })
      await w.setup.cancelInstall()
      break
    case 'installOk':
      if (m.installing) Object.assign(m, { installing: false, installed: true })
      w.finishInstall(true)
      break
    case 'installFails':
      if (m.installing) Object.assign(m, { installing: false, failure: 'network' })
      w.finishInstall(false)
      break
    case 'signIn':
      w.setup.signIn()
      if (m.installed && !m.installing && !m.signingIn) Object.assign(m, { signingIn: true, failure: null })
      break
    case 'cancelSignIn':
      if (m.signingIn) Object.assign(m, { signingIn: false, failure: 'cancelled' })
      await w.setup.cancelSignIn()
      break
    case 'signInOk':
      if (m.signingIn) Object.assign(m, { signingIn: false, signedIn: true })
      w.finishSignIn('ok')
      break
    case 'signInTimesOut':
    case 'ineligible': {
      const why = s === 'ineligible' ? 'ineligible' : 'timed_out'
      if (m.signingIn) Object.assign(m, { signingIn: false, failure: why })
      w.finishSignIn(why)
      break
    }
    case 'sessionSignedOut':
      if (m.installed && m.signedIn) m.signedIn = false
      if (m.installed) w.setup.noteSignedOut()
      break
  }
  await settle()
}

describe('the setup line against its model', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
    it(`seed ${seed}: every step shows what the model says, and says each change`, async () => {
      const w = await world()
      const m: Model = { installed: false, installing: false, signedIn: false, signingIn: false, failure: null }
      const next = rng(seed)
      const trace: string[] = []
      for (let i = 0; i < 60; i++) {
        const s = STEPS[Math.floor(next() * STEPS.length)]!
        trace.push(s)
        const before = w.seen.length
        await step(w, m, s)
        const now = w.setup.current()
        expect(now.state, trace.join(' → ')).toBe(expected(m))
        // A failure is said where the line rests after one, and cleared by the next start
        if (now.state === 'not_installed' || now.state === 'signed_out') expect(now.failure?.reason ?? null, trace.join(' → ')).toBe(m.failure)
        // Every change of state reached the listeners, and the last one they heard is what the line shows now
        if (w.seen.length > before) expect(w.seen.at(-1)!.state).toBe(now.state)
        expect(now.install).toBe('centralu')
        expect(now.signIn).toBe('centralu')
      }
    })
  }

  it('a sign-in that succeeds says the plan the agent gave', async () => {
    const w = await world()
    fakeInstall((w.setup as unknown as { deps: { home: Parameters<typeof fakeInstall>[0] } }).deps.home)
    w.setup.signIn()
    await settle()
    w.finishSignIn('ok')
    await settle()
    expect(w.setup.current()).toMatchObject({ state: 'ready', plan: { name: 'Starter' } })
  })

  it('on a system Google ships no build for, it is not installed and says why, and starts nothing', async () => {
    const t = tempData()
    data.push(t)
    let started = 0
    const setup = new AgySetup({ home: t.home, archive: null, version: AGY_RELEASE.version, runInstall: async () => void started++ })
    expect(setup.install()).toMatchObject({ state: 'not_installed', failure: { reason: 'unsupported_platform' } })
    expect(started).toBe(0)
  })
})

afterEach(endHosts)

describe('what an earlier host left', () => {
  it('removes a partial install and a sign-in folder of a host that has ended, as the next one starts', async () => {
    const t = tempData()
    data.push(t)
    const gone = otherHost()
    await gone.end()
    folder(inRoot(t.home, `.install-${gone.tag}-left01`))
    write(inRoot(t.home, `.install-${gone.tag}-left01/archive.zip`), 'partial')
    folder(inRoot(t.home, `.sign-in-${gone.tag}-left02`))
    const setup = new AgySetup({ home: t.home, archive: TEST_ARCHIVE, version: AGY_RELEASE.version })
    await setup.whenTidy()
    expect(leftovers(t.home, '.install-')).toEqual([])
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
  })

  it("keeps the install and sign-in of another host still running on the same folder (the keeper's swap, a second --db)", async () => {
    const t = tempData()
    data.push(t)
    const live = otherHost()
    const install = `.install-${live.tag}-run001`
    const signIn = `.sign-in-${live.tag}-run002`
    folder(inRoot(t.home, install))
    folder(inRoot(t.home, signIn))
    // This host's start, and a sign-in of its own, both sweep the folder
    const setup = new AgySetup({ home: t.home, archive: TEST_ARCHIVE, version: AGY_RELEASE.version })
    await setup.whenTidy()
    const own = await browserFolder(t.home)
    expect(leftovers(t.home, '.install-')).toEqual([install])
    const signIns = leftovers(t.home, '.sign-in-')
    expect(signIns).toHaveLength(2)
    expect(signIns).toContain(signIn)
    expect(signIns.find((n) => n !== signIn)).toMatch(new RegExp(`^\\.sign-in-${ownerTag()}-`))
    await own.remove()
    // Once that host has ended, the next start takes its folders away
    await live.end()
    await new AgySetup({ home: t.home, archive: TEST_ARCHIVE, version: AGY_RELEASE.version }).whenTidy()
    expect(leftovers(t.home, '.install-')).toEqual([])
    expect(leftovers(t.home, '.sign-in-')).toEqual([])
  })

  it("keeps a folder whose owner cannot be told, and takes one whose pid is now another process's", () => {
    const alive = () => true
    expect(ownerGone('123-0a1b2c3d-xyz', { alive, startOf: () => 'Wed Oct 28 10:00:00 2026' })).toBe(true)
    expect(ownerGone(`123-${ownerTag(123, () => 'Wed Oct 28 10:00:00 2026').split('-')[1]}-xyz`, { alive, startOf: () => 'Wed Oct 28 10:00:00 2026' })).toBe(false)
    // Its start unread (Windows has no ps), or not readable now: it may still be the owner
    expect(ownerGone('123-0-xyz', { alive, startOf: () => 'Wed Oct 28 10:00:00 2026' })).toBe(false)
    expect(ownerGone('123-0a1b2c3d-xyz', { alive, startOf: () => null })).toBe(false)
    // A name that records no owner (not one this build makes) is never taken
    expect(ownerGone('abc123', { alive: () => false })).toBe(false)
    expect(ownerGone('123-0-xyz', { alive: () => false })).toBe(true)
  })
})
