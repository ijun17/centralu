import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppToolResult } from '../adapters/contract.js'
import * as kit from '../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { attachWorld, type AttachWorld } from './session-apps.test-helpers.js'

/**
 * 오래 걸리는 호출 (M4 A-5, 플랜 "오래 걸리는 호출") — Codex는 MCP 도구 호출을 300초에 끊는다.
 * 그 전(240초)에 실행 id와 "아직 도는 중"을 먼저 돌려주고, 호출은 계속되며, 에이전트는 각 앱
 * 서버의 `run_status`로 이어서 본다.
 *
 * 240초는 가짜 시계로 넘긴다. 앱은 진짜 프로세스라 자기 시계로 돈다 — `hold` 도구는 문 파일이
 * 생길 때까지(또는 취소될 때까지) 붙든다.
 */

let w: AttachWorld
let hub: SessionAppsHub
const WORKER: AppSessionKey = { id: 'long-s1', kind: 'worker', projectId: 'p1' }
const NOTES = { projectId: 'p1', appId: 'notes' }
const WAIT = 240_000

const text = (r: AppToolResult) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')

/** 가짜 시계를 켜기 전에 잡아 둔 진짜 setTimeout — 가짜 시계 아래에서 진짜 IO(앱 프로세스)를 기다린다 */
const realSetTimeout = globalThis.setTimeout
async function untilIo(ok: () => boolean, ms = 15_000): Promise<void> {
  const end = performance.now() + ms
  while (!ok()) {
    if (performance.now() > end) throw new Error('timed out waiting for the app')
    await new Promise((r) => realSetTimeout(r, 10))
  }
}

/** 오래 걸리는 호출 하나를 240초 너머로 보내고, 먼저 돌려받은 결과와 실행 id를 준다 */
async function detach(a: ReturnType<SessionAppsHub['attach']>) {
  await a.tools('app-notes') // 앱을 먼저 띄운다 (진짜 시계)
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

describe('240초 — 먼저 돌려주고, 호출은 계속된다', () => {
  it('240초 전에는 기다리고, 넘기면 실행 id와 run_status 안내를 돌려준다 — 앱의 일은 멈추지 않는다', async () => {
    const a = hub.attach(WORKER)
    const { before, r, runId } = await detach(a)
    expect(before).toBe(false)
    expect(r.isError).toBe(false)
    expect(runId).toMatch(/^run_/)
    expect(text(r)).toContain(runId)
    expect(text(r)).toContain('run_status')
    expect(r.structuredContent).toEqual({ runId, status: 'running' })

    // 호출은 계속된다 — 기록은 아직 running이고, 앱은 취소를 받지 않았다
    expect(w.rt.runs(NOTES).find((x) => x.id === runId)?.status).toBe('running')
    expect(w.records('notes').some((x) => x.t === 'aborted')).toBe(false)
  })

  it('run_status는 도는 동안 "아직 도는 중"을, 끝나면 앱의 결과를 준다', async () => {
    const a = hub.attach(WORKER)
    const { runId } = await detach(a)

    const running = await a.call('app-notes', 'run_status', { run_id: runId })
    expect(running).toMatchObject({ isError: false, structuredContent: { runId, status: 'running' } })
    expect(text(running)).toContain('아직 도는 중')

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

  it('제때 끝난 호출은 그대로 돌려준다 — 먼저 돌려주기는 상한을 넘길 때만이다', async () => {
    const a = hub.attach(WORKER)
    const r = await a.call('app-notes', 'poke', { to: 2 }, { waitMs: WAIT })
    expect(r).toMatchObject({ isError: false, content: [{ type: 'text', text: 'poked 2' }] })
  })

  it('상한이 없는 호출(Claude)은 240초가 지나도 기다린다', async () => {
    const a = hub.attach(WORKER)
    await a.tools('app-notes')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const p = a.call('app-notes', 'hold', {}).then((r) => ((settled = true), r))
    await untilIo(() => w.records('notes').some((r) => r.t === 'holding'))
    // 240초도, Codex의 300초도 넘긴다. 10분에는 런타임의 host → 앱 울타리(callTimeoutMs)가 선다
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(settled).toBe(false)
    vi.useRealTimers()
    writeFileSync(w.gate('notes'), '')
    expect(text(await p)).toBe('released')
  })
})

describe('run_status가 보여 주는 것', () => {
  it('모든 앱의 목록에 읽기 전용으로 오르고, 승인 없이 불린다', async () => {
    const a = hub.attach(WORKER)
    const spec = (await a.tools('app-notes')).find((t) => t.name === 'run_status')
    expect(spec?.annotations?.readOnlyHint).toBe(true)
    expect(spec?.inputSchema).toMatchObject({ required: ['run_id'] })
    expect(a.readOnly('app-notes', 'run_status')).toBe(true)
  })

  it('다른 세션의 실행은 id를 알아도 보이지 않는다', async () => {
    const mine = hub.attach(WORKER)
    const { runId } = await detach(mine)
    const other = hub.attach({ id: 'long-s2', kind: 'worker', projectId: 'p1' })
    const r = await other.call('app-notes', 'run_status', { run_id: runId })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('모르는 실행 id')
    writeFileSync(w.gate('notes'), '')
  })

  it('제때 끝난 실행은 기록이 아는 상태만, 모르는 id는 거절', async () => {
    const a = hub.attach(WORKER)
    await a.call('app-notes', 'poke', { to: 4 })
    const runId = w.rt.runs(NOTES)[0]!.id
    const r = await a.call('app-notes', 'run_status', { run_id: runId })
    expect(r).toMatchObject({ isError: false, structuredContent: { runId, status: 'ok' } })
    expect(text(r)).toContain('결과 본문은 남아 있지 않습니다')

    const unknown = await a.call('app-notes', 'run_status', { run_id: 'run_nope' })
    expect(unknown.isError).toBe(true)
  })
})

/**
 * 세션을 멈추거나 닫으면 그 세션이 부른 앱 호출이 멈춘다 (M4 A-5) — 취소는 런타임이 앱에
 * `notifications/cancelled`로 전하고(A-4), 앱이 부탁한 아래 일까지 부모 신호로 이어진다.
 * 앱이 취소를 받았는지는 앱이 스스로 적은 기록('aborted')으로 본다.
 */
describe('세션을 멈추면 그 세션의 앱 호출이 멈춘다', () => {
  const holding = () => kit.until(() => w.records('notes').filter((r) => r.t === 'holding').length, (n) => n > 0)
  const aborted = () => kit.until(() => w.records('notes').some((r) => r.t === 'aborted'), Boolean)

  it('cancelAll은 도는 호출을 취소한다 — 앱이 취소를 받고, 기록은 cancelled', async () => {
    const a = hub.attach(WORKER)
    const p = a.call('app-notes', 'hold', {})
    await holding()
    a.cancelAll()
    const r = await p
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('취소')
    await aborted()
    expect(w.rt.runs(NOTES)[0]).toMatchObject({ tool: 'hold', status: 'cancelled', callerSessionId: WORKER.id })
  })

  it('먼저 돌려준 호출도 멈춘다 — run_status가 cancelled를 말한다', async () => {
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

  it('핸들을 닫아도(close) 멈춘다', async () => {
    const a = hub.attach(WORKER)
    const p = a.call('app-notes', 'hold', {})
    await holding()
    a.close()
    expect((await p).isError).toBe(true)
    await aborted()
  })

  it('다른 세션의 호출은 건드리지 않는다', async () => {
    const mine = hub.attach(WORKER)
    const other = hub.attach({ id: 'long-s2', kind: 'worker', projectId: 'p1' })
    const theirs = other.call('app-notes', 'hold', {})
    await holding()
    mine.cancelAll()
    // 남의 호출은 계속 돈다 — 문을 열어 끝내면 제 결과를 받는다
    await new Promise((r) => setTimeout(r, 200))
    expect(w.records('notes').some((r) => r.t === 'aborted')).toBe(false)
    writeFileSync(w.gate('notes'), '')
    expect(text(await theirs)).toBe('released')
  })
})
