import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_FILE } from '../apps/external/manifest.js'
import * as kit from '../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { attachWorld, type AttachWorld } from './session-apps.test-helpers.js'

/**
 * 어느 세션이 어느 앱을 받는가 (M4 A-5, 결정 4) — 진짜 런타임과 진짜 앱 프로세스로 본다.
 *
 *   프로젝트의 세션   그 프로젝트의 앱, 신뢰한 프로젝트일 때만
 *   오케스트레이터    사용자 폴더의 앱만
 *   붙지 않는 앱      틀린 매니페스트, 신뢰하지 않은 프로젝트, 연달아 실패해 멈춘 앱
 *
 * 그리고 그 집합이 바뀌면(앱이 오고 감, 신뢰가 뒤집힘, 도구가 바뀜) 붙은 쪽이 듣는다.
 */

let w: AttachWorld
let hub: SessionAppsHub

const worker = (projectId: string | null, id = 'w1'): AppSessionKey => ({ id, kind: 'worker', projectId })
const ORCH: AppSessionKey = { id: 'o1', kind: 'orchestrator', projectId: null }
const servers = (key: AppSessionKey) => hub.attach(key).current().map((a) => a.server)

beforeEach(() => {
  w = attachWorld(kit, { maxFailures: 1 })
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
  w.plant('p2', 'other')
  w.plant('user', 'helper')
  w.rt.refresh()
  // 짝을 못 찾은 호출(B-1)을 오래 기다리지 않게 — 제품의 값은 5초다
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 300 })
})

afterEach(async () => {
  hub.dispose()
  await w.dispose()
})

describe('결정 4 — 붙는 앱', () => {
  it('프로젝트의 세션은 신뢰한 자기 프로젝트의 앱만, 오케스트레이터는 사용자 폴더의 앱만 받는다', () => {
    expect(servers(worker('p1'))).toEqual(['app-notes', 'app-tasks'])
    // 조율 세션도 프로젝트의 세션이다 — 종류가 아니라 프로젝트가 가른다
    expect(servers({ id: 'c1', kind: 'coordinator', projectId: 'p1' })).toEqual(['app-notes', 'app-tasks'])
    // 신뢰하지 않은 프로젝트의 앱은 그 프로젝트의 세션에도 붙지 않는다
    expect(servers(worker('p2'))).toEqual([])
    // 사용자 폴더의 앱은 오케스트레이터에게만 — 프로젝트의 앱은 오케스트레이터에게 안 간다
    expect(servers(ORCH)).toEqual(['app-helper'])
    // 프로젝트가 없는 세션(오케스트레이터가 아닌)은 아무것도 받지 않는다
    expect(servers(worker(null))).toEqual([])
  })

  it('틀린 매니페스트와 연달아 실패해 멈춘 앱은 붙지 않고, 다시 시작하면 돌아온다', async () => {
    w.plant('p1', 'broken', ['--mode', 'crash-on-start'])
    writeFileSync(join(w.roots.p1, '.centralu', 'apps', 'tasks', MANIFEST_FILE), '{ not json')
    w.rt.refresh()
    const a = hub.attach(worker('p1'))
    expect(a.current().map((x) => x.server)).toEqual(['app-broken', 'app-notes'])

    let heard = 0
    a.onChange(() => heard++)
    // 픽스처가 뜨자마자 죽는다 — maxFailures 1이라 한 번에 멈춘다
    await w.rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await kit.until(() => heard, (n) => n > 0)
    expect(a.current().map((x) => x.server)).toEqual(['app-notes'])

    await w.rt.restart({ projectId: 'p1', appId: 'broken' })
    await kit.until(() => heard, (n) => n > 1)
    expect(a.current().map((x) => x.server)).toEqual(['app-broken', 'app-notes'])
  })
})

describe('붙은 앱의 집합이 바뀌면 듣는다', () => {
  it('앱 폴더가 생기고 사라지면 알림이 오고, current()가 따라간다', async () => {
    const a = hub.attach(worker('p1'))
    let heard = 0
    a.onChange(() => heard++)

    /*
     * 다시 훑기는 폴더 감시가 부르는 것과 같은 함수(rescan)다. 감시의 fs 이벤트를 기다리지 않고
     * 직접 훑는다 — 병렬 실행에서 macOS의 fs 이벤트가 몇 초씩 늦는 것을 실측했고, 감시 자체는
     * 발견 테스트(discovery.test.ts)가 본다. 여기서 보는 것은 "훑어서 바뀌었으면 알린다"다.
     */
    w.plant('p1', 'fresh')
    w.rt.refresh()
    await kit.until(() => a.current().map((x) => x.server), (s) => s.includes('app-fresh'))
    expect(heard).toBeGreaterThan(0)

    const before = heard
    rmSync(join(w.roots.p1, '.centralu', 'apps', 'fresh'), { recursive: true, force: true })
    w.rt.refresh()
    await kit.until(() => a.current().map((x) => x.server), (s) => !s.includes('app-fresh'))
    expect(heard).toBeGreaterThan(before)
  })

  it('신뢰가 뒤집히면 붙은 앱이 모두 떨어지고, 되돌리면 다시 붙는다', async () => {
    const a = hub.attach(worker('p1'))
    let heard = 0
    a.onChange(() => heard++)

    w.trust.p1 = false
    w.rt.refresh()
    await kit.until(() => heard, (n) => n === 1)
    expect(a.current()).toEqual([])

    w.trust.p1 = true
    w.rt.refresh()
    await kit.until(() => heard, (n) => n === 2)
    expect(a.current().map((x) => x.server)).toEqual(['app-notes', 'app-tasks'])
  })

  it('다른 세션에만 해당하는 변화는 알리지 않는다 — 사용자 폴더 앱이 늘어도 프로젝트 세션은 조용하다', async () => {
    const a = hub.attach(worker('p1'))
    const o = hub.attach(ORCH)
    let heardA = 0
    let heardO = 0
    a.onChange(() => heardA++)
    o.onChange(() => heardO++)

    w.plant('user', 'second')
    w.rt.refresh()
    await kit.until(() => heardO, (n) => n > 0)
    expect(heardA).toBe(0)
  })
})

describe('도구 목록', () => {
  it('처음에는 모르고(null), 처음 필요할 때 앱을 띄워 에이전트 도구만 읽는다 — 설명과 주석은 그대로', async () => {
    const a = hub.attach(worker('p1'))
    expect(a.current().find((x) => x.server === 'app-notes')?.tools).toBeNull()
    // 붙이는 것만으로는 앱이 뜨지 않는다 (성능 예산: 아무것도 안 할 때 앱 프로세스 0개)
    expect(w.records('notes').filter((r) => r.t === 'start')).toEqual([])

    let heard = 0
    a.onChange(() => heard++)
    const tools = await a.tools('app-notes')
    const names = tools.map((t) => t.name).sort()
    // app_only는 화면 전용이다 — 에이전트의 목록에 오르지 않는다. run_status는 host가 더한 도구다
    expect(names).toEqual(['echo', 'hold', 'peek', 'poke', 'run_status'])
    expect(tools.find((t) => t.name === 'peek')).toMatchObject({
      title: 'Peek',
      description: 'Reads the value without changing anything',
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
    expect(tools.find((t) => t.name === 'poke')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { to: { type: 'number', description: 'the new value' } },
    })

    // 읽은 목록은 기억된다 — 앱이 내려가도 다음 세션은 앱을 띄우지 않고 목록을 안다
    await kit.until(() => heard, (n) => n > 0)
    await w.rt.restart({ projectId: 'p1', appId: 'notes' })
    const b = hub.attach(worker('p1', 'w2'))
    expect(b.current().find((x) => x.server === 'app-notes')?.tools?.map((t) => t.name).sort()).toEqual(names)
    expect(w.records('notes').filter((r) => r.t === 'start')).toHaveLength(1)
  })

  it('앱이 다시 뜨며 도구가 달라지면 알린다', async () => {
    const extra = join(w.root, 'extra.json')
    w.plant('p1', 'grows', ['--mode', 'attach', '--extra-from', extra])
    w.rt.refresh()
    const a = hub.attach(worker('p1'))
    await a.tools('app-grows')
    let heard = 0
    a.onChange(() => heard++)

    writeFileSync(extra, JSON.stringify(['added_later']))
    await w.rt.restart({ projectId: 'p1', appId: 'grows' })
    await a.tools('app-grows') // 기억한 목록을 준다 — 앱을 띄우는 것은 다음 필요다
    await w.rt.tools({ projectId: 'p1', appId: 'grows' }, 'model')
    await kit.until(() => heard, (n) => n > 0)
    expect(a.current().find((x) => x.server === 'app-grows')?.tools?.map((t) => t.name)).toContain('added_later')
  })
})

describe('부르기', () => {
  it('세션의 호출은 호출자가 그 세션인 채로 런타임에 닿고 기록된다', async () => {
    const a = hub.attach(worker('p1', 'sess-rec'))
    const out = await a.call('app-notes', 'poke', { to: 3 })
    expect(out).toMatchObject({ isError: false, content: [{ type: 'text', text: 'poked 3' }] })

    const runs = w.rt.runs({ projectId: 'p1', appId: 'notes' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ tool: 'poke', callerKind: 'session', callerSessionId: 'sess-rec', status: 'ok' })
  })

  it('붙지 않은 앱은 이름을 알아도 부를 수 없다 — 런타임까지 가지 않는다', async () => {
    const a = hub.attach(worker('p1'))
    // 다른 프로젝트의 앱, 사용자 폴더의 앱
    for (const server of ['app-other', 'app-helper']) {
      const out = await a.call(server, 'echo', { text: 'x' })
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toContain('이 세션에 붙은 앱이 아닙니다')
    }
    expect(w.rt.runs({ projectId: 'p2', appId: 'other' })).toEqual([])
    expect(w.rt.runs({ projectId: null, appId: 'helper' })).toEqual([])
  })

  it('신뢰를 잃은 뒤의 호출은 막힌다 — 붙을 때가 아니라 부를 때마다 다시 본다', async () => {
    const a = hub.attach(worker('p1'))
    w.trust.p1 = false
    w.rt.refresh()
    const out = await a.call('app-notes', 'echo', { text: 'x' })
    expect(out.isError).toBe(true)
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })).toEqual([])
  })
})

/**
 * 호출과 대화 카드의 짝 (M4 B-1). 대화 안 화면은 그 호출의 카드 아래에 선다 — 어느 카드인지를 붙이기가
 * 정한다. 어댑터가 id를 주면 그것이고, 아니면 어댑터가 본 호출 시작(`noteCall`)과 (서버, 도구, 인자)로
 * 먼저 온 순서대로 짝짓는다. 두 알림은 다른 길(Codex의 표준 출력, 다리의 WebSocket)로 오므로 어느 쪽이
 * 먼저여도 맞아야 한다.
 */
describe('카드 id 짝짓기 (B-1)', () => {
  const heard = () => {
    const calls: { tool: string; callId: Promise<string | null> }[] = []
    hub.onCall((c) => calls.push({ tool: c.tool, callId: c.callId }))
    return calls
  }

  it('어댑터가 준 id가 곧 카드다', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    await a.call('app-notes', 'poke', { to: 1 }, { callId: 'toolu_1' })
    expect(await calls[0]!.callId).toBe('toolu_1')
  })

  it('어댑터가 먼저 본 호출 시작과 짝짓는다 — 인자의 키 순서와 문자열·객체 모양은 가리지 않는다', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    a.noteCall('item-1', 'app-notes', 'poke', '{"to":2,"x":{"b":1,"a":2}}')
    a.noteCall('item-2', 'app-notes', 'poke', { to: 3 })
    await a.call('app-notes', 'poke', { to: 3 })
    await a.call('app-notes', 'poke', { x: { a: 2, b: 1 }, to: 2 })
    expect(await Promise.all(calls.map((c) => c.callId))).toEqual(['item-2', 'item-1'])
  })

  it('호출이 먼저 와도 뒤이어 온 호출 시작과 짝짓는다', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    const p = a.call('app-notes', 'poke', { to: 4 })
    await kit.until(() => calls.length, (n) => n === 1)
    a.noteCall('item-4', 'app-notes', 'poke', { to: 4 })
    await p
    expect(await calls[0]!.callId).toBe('item-4')
  })

  it('끝난 카드(승인에서 거절된 호출)는 짝짓기에서 빠진다 — 같은 인자로 다시 부른 호출이 옛 카드에 붙지 않는다', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    a.noteCall('denied', 'app-notes', 'poke', { to: 5 })
    a.callEnded('denied')
    a.noteCall('retry', 'app-notes', 'poke', { to: 5 })
    await a.call('app-notes', 'poke', { to: 5 })
    expect(await calls[0]!.callId).toBe('retry')
  })

  it('짝이 끝내 오지 않으면 null이다 — 호출은 그대로 끝난다', async () => {
    hub.dispose()
    hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 100 })
    const calls = heard()
    const a = hub.attach(worker('p1'))
    // 다른 도구·다른 인자의 시작은 이 호출의 짝이 아니다
    a.noteCall('item-x', 'app-notes', 'peek', {})
    a.noteCall('item-y', 'app-notes', 'poke', { to: 99 })
    const out = await a.call('app-notes', 'poke', { to: 6 })
    expect(out.isError).toBe(false)
    expect(await calls[0]!.callId).toBeNull()
  })
})
