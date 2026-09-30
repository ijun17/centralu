import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppToolResult } from '../adapters/contract.js'
import * as kit from '../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { attachWorld, type AttachWorld } from './session-apps.test-helpers.js'

/**
 * Long-running calls (M4 A-5, the plan's "long-running calls") — Codex cuts off an MCP tool call
 * at 300 seconds. Before that (at 240 seconds), the run id and "still running" are handed back
 * early, the call keeps going, and the agent follows up with each app server's `run_status`.
 *
 * The 240 seconds are advanced with a fake clock. The app is a real process, so it runs on its
 * own clock — the `hold` tool holds until a gate file appears (or it is cancelled).
 */

let w: AttachWorld
let hub: SessionAppsHub
const WORKER: AppSessionKey = { id: 'long-s1', kind: 'worker', projectId: 'p1' }
const NOTES = { projectId: 'p1', appId: 'notes' }
const WAIT = 240_000

const text = (r: AppToolResult) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')

/** The real setTimeout, captured before the fake clock is turned on — used to wait for real IO (the app process) under a fake clock */
const realSetTimeout = globalThis.setTimeout
async function untilIo(ok: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out waiting for the app')
    await new Promise((r) => realSetTimeout(r, 10))
  }
}

/** Pushes one long-running call past 240 seconds, and returns the early-returned result and its run id */
async function detach(a: ReturnType<SessionAppsHub['attach']>) {
  await a.tools('app-notes') // spin up the app first (a real clock)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settled = false
  const p = a.call('app-notes', 'hold', {}, { waitMs: WAIT }).then((r) => ((settled = true), r))
  await untilIo(() => w.records('notes').some((r) => r.t === 'holding'))
  await vi.advanceTimersByTimeAsync(WAIT - 1_000)
  const before = settled
  await vi.advanceTimersByTimeAsync(1_000)
  const r = await p
  vi.useRealTimers()
  return { before, r, runId: (r.structuredContent as { runId: string }).runId }
}

beforeEach(() => {
  w = attachWorld(kit)
  w.plant('p1', 'notes')
  w.rt.refresh()
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000 })
})

afterEach(async () => {
  vi.useRealTimers()
  hub.dispose()
  await w.dispose()
})

describe('240 seconds — hand back an early result, and the call keeps going', () => {
  it('waits before 240 seconds, and past it returns the run id and run_status guidance — the app\'s work does not stop', async () => {
    const a = hub.attach(WORKER)
    const { before, r, runId } = await detach(a)
    expect(before).toBe(false)
    expect(r.isError).toBe(false)
    expect(runId).toMatch(/^run_/)
    expect(text(r)).toContain(runId)
    expect(text(r)).toContain('run_status')
    expect(r.structuredContent).toEqual({ runId, status: 'running' })

    // The call keeps going — the record still says running, and the app never received a cancellation
    expect(w.rt.runs(NOTES).find((x) => x.id === runId)?.status).toBe('running')
    expect(w.records('notes').some((x) => x.t === 'aborted')).toBe(false)
  })

  it('run_status says "still running" while it runs, and gives the app\'s result once it finishes', async () => {
    const a = hub.attach(WORKER)
    const { runId } = await detach(a)

    const running = await a.call('app-notes', 'run_status', { run_id: runId })
    expect(running).toMatchObject({ isError: false, structuredContent: { runId, status: 'running' } })
    expect(text(running)).toContain('still running')

    writeFileSync(w.gate('notes'), '')
    let done: AppToolResult | null = null
    await kit.until(
      () => done,
      () => {
        void a.call('app-notes', 'run_status', { run_id: runId }).then((x) => (done = x))
        return (done?.structuredContent as { status?: string } | undefined)?.status === 'ok'
      },
      10_000,
    )
    expect(done!.isError).toBe(false)
    expect(text(done!)).toContain('released')
    expect(w.rt.runs(NOTES).find((x) => x.id === runId)?.status).toBe('ok')
  })

  it('a call that finishes in time is returned normally — an early return only happens once the cap is exceeded', async () => {
    const a = hub.attach(WORKER)
    const r = await a.call('app-notes', 'poke', { to: 2 }, { waitMs: WAIT })
    expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'poked 2' }] })
  })

  it('a call with no cap (Claude) keeps waiting even past 240 seconds', async () => {
    const a = hub.attach(WORKER)
    await a.tools('app-notes')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const p = a.call('app-notes', 'hold', {}).then((r) => ((settled = true), r))
    await untilIo(() => w.records('notes').some((r) => r.t === 'holding'))
    // Past both 240 seconds and Codex's 300-second cutoff. At 10 minutes the runtime's host-to-app fence (callTimeoutMs) kicks in
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(settled).toBe(false)
    vi.useRealTimers()
    writeFileSync(w.gate('notes'), '')
    expect(text(await p)).toBe('released')
  })
})

describe('what run_status shows', () => {
  it('appears read-only in every app\'s list, and is called with no approval', async () => {
    const a = hub.attach(WORKER)
    const spec = (await a.tools('app-notes')).find((t) => t.name === 'run_status')
    expect(spec?.annotations?.readOnlyHint).toBe(true)
    expect(spec?.inputSchema).toMatchObject({ required: ['run_id'] })
    expect(a.readOnly('app-notes', 'run_status')).toBe(true)
  })

  it('another session\'s run is invisible even if you know its id', async () => {
    const mine = hub.attach(WORKER)
    const { runId } = await detach(mine)
    const other = hub.attach({ id: 'long-s2', kind: 'worker', projectId: 'p1' })
    const r = await other.call('app-notes', 'run_status', { run_id: runId })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Unknown run id')
    writeFileSync(w.gate('notes'), '')
  })

  it('a run that finished in time gives only the status the record knows, and an unknown id is refused', async () => {
    const a = hub.attach(WORKER)
    await a.call('app-notes', 'poke', { to: 4 })
    const runId = w.rt.runs(NOTES)[0]!.id
    const r = await a.call('app-notes', 'run_status', { run_id: runId })
    expect(r).toMatchObject({ isError: false, structuredContent: { runId, status: 'ok' } })
    expect(text(r)).toContain('its result is no longer kept')

    const unknown = await a.call('app-notes', 'run_status', { run_id: 'run_nope' })
    expect(unknown.isError).toBe(true)
  })
})

/**
 * Stopping or closing a session stops the app calls that session made (M4 A-5) — cancellation is
 * carried to the app by the runtime as `notifications/cancelled` (A-4), and propagates as a parent
 * signal down to any work the app itself assigned. Whether the app received the cancellation is
 * checked through a record the app writes itself ('aborted').
 */
describe('stopping a session stops that session\'s app calls', () => {
  const holding = () => kit.until(() => w.records('notes').filter((r) => r.t === 'holding').length, (n) => n > 0)
  const aborted = () => kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)

  it('cancelAll cancels a running call — the app receives the cancellation, and the record says cancelled', async () => {
    const a = hub.attach(WORKER)
    const p = a.call('app-notes', 'hold', {})
    await holding()
    a.cancelAll()
    const r = await p
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('cancelled')
    await aborted()
    expect(w.rt.runs(NOTES)[0]).toMatchObject({ tool: 'hold', status: 'cancelled', callerSessionId: WORKER.id })
  })

  it('an early-returned call is also stopped — run_status reports cancelled', async () => {
    const a = hub.attach(WORKER)
    const { runId } = await detach(a)
    a.cancelAll()
    await aborted()
    let seen: AppToolResult | null = null
    await kit.until(
      () => seen,
      () => {
        void a.call('app-notes', 'run_status', { run_id: runId }).then((x) => (seen = x))
        return (seen?.structuredContent as { status?: string } | undefined)?.status === 'cancelled'
      },
    )
    expect(seen!.isError).toBe(true)
  })

  it('closing the handle (close) also stops it', async () => {
    const a = hub.attach(WORKER)
    const p = a.call('app-notes', 'hold', {})
    await holding()
    a.close()
    expect((await p).isError).toBe(true)
    await aborted()
  })

  it('does not touch another session\'s call', async () => {
    const mine = hub.attach(WORKER)
    const other = hub.attach({ id: 'long-s2', kind: 'worker', projectId: 'p1' })
    const theirs = other.call('app-notes', 'hold', {})
    await holding()
    mine.cancelAll()
    // The other call keeps running — opening the gate lets it finish and receive its own result
    await new Promise((r) => setTimeout(r, 200))
    expect(w.records('notes').some((r) => r.t === 'aborted')).toBe(false)
    writeFileSync(w.gate('notes'), '')
    expect(text(await theirs)).toBe('released')
  })
})
