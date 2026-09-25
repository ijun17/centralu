import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppRef, type RuntimeTiming } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'

/**
 * 반영 (M4 C-4) — 앱 폴더가 바뀌면 **만드는 세션의 턴이 끝날 때** 한 번 다시 띄운다. 진행 중인 호출은 끊지 않는다.
 * 만드는 세션이 없거나 쉬고 있으면 조용해지기를 기다린다.
 *
 * fs 이벤트를 기다리지 않는다(#153): 감시가 부를 훑기를 테스트가 직접 부른다(`refresh`). 판정은 앱 프로세스가 스스로
 * 말한 pid와, 런타임이 아는 도구 목록으로 한다.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let busy = false
let rt: ExternalApps

const ID = 'counter'
const ref: AppRef = { projectId: 'p1', appId: ID }
const SESSION = { kind: 'session' as const, sessionId: 's1' }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-reload-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  busy = false
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

function make(opts: { builder?: boolean; timing?: Partial<RuntimeTiming> } = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, reloadQuietMs: 400, turnEndDebounceMs: 100, ...opts.timing },
    ...(opts.builder === false ? {} : { builderBusy: () => busy }),
  })
  rt.refresh()
  return rt
}

const gate = () => join(root, 'gate')
const serverFile = () => join(projRoot, '.centralu', 'apps', ID, 'server.mjs')

/** 템플릿 앱에 시험용 도구 둘(pid, hold)을 더해 펼친다 */
function plant(): void {
  const dir = join(projRoot, '.centralu', 'apps', ID)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id: ID, name: 'Counter', description: 'counter' })
  addTools(`
  centralu.tool(server, 'pid', { description: 'The process id', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: String(process.pid) }] }))
  centralu.tool(server, 'hold', { description: 'Waits for the gate file', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate())})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'held by ' + process.pid }] }
  })`)
}

/** 만드는 에이전트가 하는 일 — server.mjs에 도구를 더한다 */
function addTools(code: string): void {
  const f = serverFile()
  writeFileSync(f, readFileSync(f, 'utf8').replace('  return server\n})', `${code}\n  return server\n})`))
}
const addTool = (name: string) =>
  addTools(`  centralu.tool(server, ${JSON.stringify(name)}, { description: 'New', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))`)

async function pid(): Promise<number> {
  const out = await rt.call(ref, 'pid', {}, SESSION)
  return Number(resultText(out.result!))
}
const known = () => rt.knownTools(ref)?.map((t) => t.name) ?? []
const status = () => rt.list().find((a) => a.appId === ID)?.status
const reloads = () => (readFileSync(join(dataRoot, 'app-logs', 'p1', `${ID}.log`), 'utf8').match(/reloading: /g) ?? []).length
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('만드는 세션의 턴이 끝날 때 다시 띄운다', () => {
  it('턴 안에서는 폴더가 바뀌어도 그대로다 — 턴이 끝나면 한 번, 새 코드로 뜬다', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    busy = true
    addTool('added')
    rt.refresh() // 감시가 부르는 훑기
    await sleep(700) // 조용해지기(400ms)를 넘겨도
    expect(await pid()).toBe(before)
    expect(known()).not.toContain('added')

    busy = false
    // 턴 끝과 상태 변화가 잇달아 와도 한 번이다
    rt.builderTurnEnded(ref)
    rt.builderTurnEnded(ref)
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('added'))
    expect(await pid()).not.toBe(before)
    await sleep(300)
    expect(reloads()).toBe(1)
    expect(status()).toBe('running')
  })

  it('진행 중인 호출은 끊지 않는다 — 끝나기를 기다렸다가 다시 띄운다', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    const held = rt.call(ref, 'hold', {}, SESSION)
    await until(() => (rt as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    addTool('added')
    rt.builderTurnEnded(ref)
    await sleep(500)
    expect(known()).not.toContain('added') // 아직 옛 프로세스다 — 호출이 도는 중
    writeFileSync(gate(), '')
    const out = await held
    expect({ status: out.status, error: out.error }).toEqual({ status: 'ok', error: null })
    expect(resultText(out.result!)).toBe(`held by ${before}`)
    await until(known, (names) => names.includes('added'))
    expect(await pid()).not.toBe(before)
  })

  it('폴더가 그대로면 턴이 끝나도 다시 띄우지 않는다', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    // 같은 내용으로 다시 쓴 것은 바뀐 것이 아니다 (편집기의 저장, 같은 내용의 체크아웃)
    writeFileSync(serverFile(), readFileSync(serverFile(), 'utf8'))
    rt.builderTurnEnded(ref)
    await sleep(400)
    expect(await pid()).toBe(before)
  })

  it('쉬다 내려간 앱도 턴 끝에 새 코드로 띄워 도구 목록을 간다', async () => {
    plant()
    make()
    await rt.tools(ref)
    await rt.restart(ref) // 내린다 (띄우지는 않는다)
    expect(status()).toBe('stopped')
    addTool('added')
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('added'))
    expect(status()).toBe('running')
  })

  it('고친 코드가 못 뜨면 이유가 남고, 다음 고침의 턴 끝에 다시 해 본다', async () => {
    plant()
    make()
    await rt.tools(ref)
    addTools(`  throw new Error('half-written tool')`)
    rt.builderTurnEnded(ref)
    await until(status, (s) => s === 'crashed')
    expect(rt.list().find((a) => a.appId === ID)!.error).toContain('half-written tool')
    writeFileSync(serverFile(), readFileSync(serverFile(), 'utf8').replace(`  throw new Error('half-written tool')\n`, ''))
    addTool('fixed')
    rt.builderTurnEnded(ref)
    await until(known, (names) => names.includes('fixed'))
    expect(status()).toBe('running')
  })
})

describe('만드는 세션이 없으면 조용해진 뒤 다시 띄운다', () => {
  it('마지막 변화 뒤 조용해질 때까지 기다린다 — 변화가 이어지면 다시 센다', async () => {
    plant()
    make({ builder: false })
    await rt.tools(ref)
    const before = await pid()
    addTool('one')
    rt.refresh()
    await sleep(250)
    addTool('two')
    rt.refresh() // 다시 센다 — 400ms는 여기서부터다
    await sleep(250)
    expect(await pid()).toBe(before) // 첫 변화에서 500ms가 지났지만 마지막 변화에서는 250ms
    await until(known, (names) => names.includes('one') && names.includes('two'))
    expect(await pid()).not.toBe(before)
    expect(reloads()).toBe(1)
  })

  it('만드는 세션이 쉬고 있으면(편집기에서 고쳤다) 같은 길이다 — 턴 안이면 턴 끝을 기다린다', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    addTool('edited')
    rt.refresh()
    await until(known, (names) => names.includes('edited'))
    expect(await pid()).not.toBe(before)
  })

  it('떠 있지 않은 앱은 편집 때문에 깨우지 않는다', async () => {
    plant()
    make({ builder: false })
    await rt.tools(ref)
    await rt.restart(ref)
    addTool('added')
    rt.refresh()
    // 조용해지기(400ms)의 몇 배 — 감시도 이 편집을 보고 시계를 다시 걸 수 있다(플러시 300ms)
    await sleep(1_500)
    expect(status()).toBe('stopped')
  })
})

describe('매니페스트가 바뀌어도 진행 중인 호출은 끝까지 간다', () => {
  it('새 호출은 새 매니페스트의 앱이 받고, 옛 프로세스는 호출을 마친 뒤 내려간다', async () => {
    plant()
    make()
    await rt.tools(ref)
    const before = await pid()
    const held = rt.call(ref, 'hold', {}, SESSION)
    await until(() => (rt as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    const mf = join(projRoot, '.centralu', 'apps', ID, 'centralu.app.json')
    writeFileSync(mf, readFileSync(mf, 'utf8').replace('"description": "counter"', '"description": "counter, renamed"'))
    rt.refresh()
    expect(rt.list().find((a) => a.appId === ID)!.description).toBe('counter, renamed')
    await sleep(300)
    writeFileSync(gate(), '')
    const out = await held
    expect({ status: out.status, error: out.error }).toEqual({ status: 'ok', error: null })
    expect(resultText(out.result!)).toBe(`held by ${before}`)
    expect(await pid()).not.toBe(before)
    expect(existsSync(gate())).toBe(true)
  })
})
