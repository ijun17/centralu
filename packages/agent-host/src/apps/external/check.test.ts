import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AppRef, type RuntimeTiming } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'

/**
 * 앱 점검 (M4 C-3) — 템플릿으로 펼친 앱의 `server.mjs`를 일부러 틀리게 고쳐, `check`가 그 문제를 **실제로 띄운
 * 앱에서** 잡는지 본다. 템플릿 그대로는 통과해야 한다.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-check-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const status = (id: string) => rt.list().find((a) => a.appId === id)?.status

function make(timing: Partial<RuntimeTiming> = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  return rt
}

/** 템플릿 앱 하나 — `server`를 주면 server.mjs를 그것으로 갈아 끼운다 (템플릿 런타임을 그대로 쓴다) */
function app(id: string, server?: string, manifest?: (m: Record<string, unknown>) => void): string {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: id, description: `${id} app` })
  if (server !== undefined) writeFileSync(join(dir, 'server.mjs'), `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'\n${server}\n`)
  if (manifest) {
    const m = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8'))
    manifest(m)
    writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify(m, null, 2))
  }
  return dir
}

/** 화면 하나와 홈 도구 하나를 가진 서버 — `extra`로 틀린 도구를 더한다 */
const serverWith = (extra: string, home = `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/index.html' } } }, async () => ({ content: [{ type: 'text', text: 'hi' }] }))`) => `
serveStdio(() => {
  const server = new McpServer({ name: 'x', version: '0' }, { capabilities: { tools: {}, resources: {} } })
  centralu.uiResource(server, 'screen', 'ui://x/index.html', new URL('./ui/index.html', import.meta.url))
  ${home}
  ${extra}
  return server
})`

const problems = (text: string) => text.split('\n').filter((l) => l.startsWith('- 문제'))

describe('템플릿 그대로는 통과한다', () => {
  it('매니페스트·도구·화면 모두 문제 없음 — 도구마다 무엇인지와 화면의 크기를 말한다', async () => {
    app('counter')
    const r = await make().check(ref('counter'))
    expect(problems(r.text)).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/^check p1\/counter: 통과/)
    expect(r.text).toContain('show — 읽기, model+app, 화면 ui://counter/index.html')
    expect(r.text).toContain('increment — 바꿈, model+app')
    expect(r.text).toContain('reset — 바꿈, app')
    expect(r.text).toMatch(/화면 ui:\/\/counter\/index\.html: \d{4,}자/)
    expect(r.text).toMatch(/프로세스: pid \d+, (modern|legacy) \(.+\), 지금 파일로 다시 띄움/)
    // 점검 뒤 앱은 보통의 떠 있는 앱이다 — 도구도 그대로 부른다
    expect(status('counter')).toBe('running')
    const out = await rt.call(ref('counter'), 'increment', { by: 1 }, { kind: 'session', sessionId: 's1' })
    expect(out.status).toBe('ok')
  })
})

describe('틀린 앱은 무엇이 어디서 틀렸는지 말한다', () => {
  it('도구 이름의 __ — Centralu가 빼는 도구다', async () => {
    app('names', serverWith(`server.registerTool('save__draft', { description: 'Save', annotations: { readOnlyHint: false } }, async () => ({ content: [] }))`))
    const r = await make().check(ref('names'))
    expect(r.ok).toBe(false)
    expect(problems(r.text)).toEqual([
      '- 문제 [도구 save__draft] 도구 이름에 "__"를 쓸 수 없습니다 (세션에서 도구 이름의 칸막이입니다): save__draft — Centralu가 이 도구를 빼서 아무도 부를 수 없습니다',
    ])
  })

  it('바꾸는 도구에 readOnlyHint가 없다', async () => {
    app('annot', serverWith(`centralu.tool(server, 'save', { description: 'Save the note', inputSchema: z.object({ text: z.string() }) }, async () => ({ content: [] }))`))
    const r = await make().check(ref('annot'))
    expect(problems(r.text)).toEqual([
      '- 문제 [도구 save] annotations.readOnlyHint가 없습니다 — 읽기만 하면 `readOnlyHint: true`, 무엇이든 바꾸면 `readOnlyHint: false`를 적으세요. 없으면 바꾸는 도구로 다뤄져 세션이 부를 때마다 묻고, Codex의 auto 프리셋은 부르지 않으며, 부를 때마다 이 앱의 열린 화면이 모두 다시 읽습니다',
    ])
    expect(r.text).toContain('save — readOnlyHint 없음, model+app')
  })

  it('home에 화면이 없다 / home이 화면에 닫혀 있다 / home이 목록에 없다', async () => {
    app('nohome-ui', serverWith('', `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))`))
    app('hidden-home', serverWith('', `centralu.tool(server, 'show', { description: 'Show', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/index.html', visibility: ['model'] } } }, async () => ({ content: [] }))`))
    app('lost-home', serverWith(''), (m) => (m.home = 'open'))
    const r = make()
    expect(problems((await r.check(ref('nohome-ui'))).text)).toEqual([
      '- 문제 [home (show)] home 도구에 화면이 없습니다 — `_meta: { ui: { resourceUri: "ui://…" } }`를 달고 그 리소스를 `centralu.uiResource`로 등록하세요',
    ])
    expect(problems((await r.check(ref('hidden-home'))).text)).toEqual([
      '- 문제 [home (show)] home 도구가 화면에 열려 있지 않습니다 (visibility: ["model"]) — 앱을 열 때 Centralu는 화면의 자리에서 home을 부릅니다',
    ])
    expect(problems((await r.check(ref('lost-home'))).text)).toEqual([
      '- 문제 [home (open)] centralu.app.json의 home이 가리키는 도구가 도구 목록에 없습니다 — 사이드바에서 앱을 열 수 없습니다',
    ])
  })

  it('공개 범위의 모양이 틀렸다', async () => {
    app('vis', serverWith(`centralu.tool(server, 'peek', { description: 'Peek', annotations: { readOnlyHint: true }, _meta: { ui: { visibility: 'app' } } }, async () => ({ content: [] }))`))
    expect(problems((await make().check(ref('vis'))).text)).toEqual([
      '- 문제 [도구 peek] peek: _meta.ui.visibility는 "model"·"app"의 배열이어야 합니다 (받은 값: "app") — Centralu가 이 도구를 뺍니다',
    ])
  })

  it('화면: 가리킨 ui://가 없다 / ui://가 아니다 / 브리지 없이 날것으로 냈다', async () => {
    app('screens', serverWith(`
  centralu.tool(server, 'missing', { description: 'M', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/missing.html' } } }, async () => ({ content: [] }))
  centralu.tool(server, 'web', { description: 'W', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'https://example.com/app' } } }, async () => ({ content: [] }))
  centralu.tool(server, 'raw', { description: 'R', annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: 'ui://x/raw.html' } } }, async () => ({ content: [] }))
  server.registerResource('raw', 'ui://x/raw.html', { mimeType: 'text/html' }, async () => ({ contents: [{ uri: 'ui://x/raw.html', mimeType: 'text/html', text: '<script src="centralu:mcp-app.js"></script>' }] }))`))
    const found = problems((await make().check(ref('screens'))).text)
    expect(found).toHaveLength(4)
    expect(found[0]).toBe('- 문제 [도구 web] web: _meta.ui.resourceUri must be a ui:// URI (got "https://example.com/app") — 화면으로 뜨지 않습니다')
    expect(found[1]).toMatch(/^- 문제 \[화면 ui:\/\/x\/missing\.html\] 읽지 못했습니다: .*missing\.html/)
    expect(found[2]).toBe('- 문제 [화면 ui://x/raw.html] mimeType이 "text/html"입니다 — 화면은 "text/html;profile=mcp-app"이어야 합니다 (centralu.uiResource가 맞춰 줍니다)')
    expect(found[3]).toBe('- 문제 [화면 ui://x/raw.html] <script src="centralu:mcp-app.js">가 그대로 남았습니다 — 이 화면에는 브리지가 없어 도구를 부를 수 없습니다. centralu.uiResource로 등록하세요')
  })

  it('매니페스트가 틀렸다 — 띄우지 않고 이유를 말한다', async () => {
    app('manifest', undefined, (m) => {
      m.id = 'other'
      m.extra = 1
    })
    const r = await make().check(ref('manifest'))
    expect(problems(r.text)).toEqual([
      '- 문제 [centralu.app.json] 폴더 이름(manifest)과 매니페스트의 id(other)가 다릅니다 — 폴더 이름이 곧 id입니다',
    ])
    expect(r.text).toContain('- 주의 [centralu.app.json] 모르는 필드는 무시합니다: extra')
  })

  it('서버가 뜨지 못한다 — 이유와 표준에러가 보고서에 있다', async () => {
    app('broken', `serveStdio(() => { throw new Error('forgot to define the tools') })`)
    const r = await make().check(ref('broken'))
    expect(r.ok).toBe(false)
    expect(problems(r.text)[0]).toMatch(/^- 문제 \[시작\] /)
    expect(r.text).toContain('forgot to define the tools')
    expect(r.text).toContain('the server could not start')
  })
})

describe('점검은 앱을 이상한 상태로 두지 않는다', () => {
  it('뜨지 못하는 앱을 몇 번 점검해도 멈춤(failed)으로 밀리지 않고, 고치면 통과하고 떠 있다', async () => {
    const dir = app('fixme', `serveStdio(() => { throw new Error('not yet') })`)
    const r = make({ maxFailures: 3 })
    for (let i = 0; i < 4; i++) expect((await r.check(ref('fixme'))).ok).toBe(false)
    expect(status('fixme')).toBe('crashed')
    // 부르는 쪽이 연달아 실패시켜 멈춘 앱도 — 점검은 다시 띄워 본다(사람의 "다시 시작"과 같다)
    for (let i = 0; i < 3; i++) await r.tools(ref('fixme')).catch(() => {})
    expect(status('fixme')).toBe('failed')
    writeFileSync(join(dir, 'server.mjs'), readFileSync(join(appTemplateDir(), 'server.mjs'), 'utf8').replaceAll('{{APP_ID}}', 'fixme').replaceAll('{{APP_NAME}}', 'fixme'))
    const fixed = await r.check(ref('fixme'))
    expect(fixed.ok).toBe(true)
    expect(status('fixme')).toBe('running')
  })

  it('진행 중인 호출은 끊지 않는다 — 끝나기를 기다렸다가 지금 파일로 다시 띄운다', async () => {
    const gate = join(root, 'gate')
    const dir = app(
      'busy',
      serverWith(`centralu.tool(server, 'hold', { description: 'Waits for the gate file', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'held pid ' + process.pid }] }
  })`),
    )
    const r = make()
    await r.tools(ref('busy'))
    const call = r.call(ref('busy'), 'hold', {}, { kind: 'session', sessionId: 's1' })
    await until(() => (r as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    // 그사이 코드가 바뀌었다 — 도구 하나를 더한다
    writeFileSync(join(dir, 'server.mjs'), readFileSync(join(dir, 'server.mjs'), 'utf8').replace("  return server\n", "  centralu.tool(server, 'added', { description: 'New', annotations: { readOnlyHint: true } }, async () => ({ content: [] }))\n  return server\n"))
    let checked = false
    const report = r.check(ref('busy')).then((x) => ((checked = true), x))
    await new Promise((res) => setTimeout(res, 300))
    expect(checked).toBe(false) // 호출이 끝나기 전에는 내리지 않는다
    writeFileSync(gate, '')
    const out = await call
    expect(out.status).toBe('ok')
    const held = Number(resultText(out.result!).replace('held pid ', ''))
    const rep = await report
    expect(rep.text).toContain('added — 읽기, model+app')
    expect(rep.text).toContain('지금 파일로 다시 띄움')
    expect(rep.text).not.toContain(`pid ${held},`)
  })

  it('호출이 상한 넘게 돌면 다시 띄우지 않고 떠 있는 것을 보며, 그렇다고 적는다', async () => {
    const gate = join(root, 'gate2')
    app(
      'slow',
      serverWith(`centralu.tool(server, 'hold', { description: 'Waits', annotations: { readOnlyHint: true } }, async () => {
    const { existsSync } = await import('node:fs')
    while (!existsSync(${JSON.stringify(gate)})) await new Promise((r) => setTimeout(r, 20))
    return { content: [{ type: 'text', text: 'done' }] }
  })`),
    )
    const r = make({ checkDrainMs: 200 })
    const call = r.call(ref('slow'), 'hold', {}, { kind: 'session', sessionId: 's1' })
    await until(() => (r as unknown as { openRuns: Map<string, unknown> }).openRuns.size, (n) => n === 1)
    const rep = await r.check(ref('slow'))
    expect(rep.text).toContain('- 참고: 호출 1개가 200ms 넘게 도는 중이라 다시 띄우지 않았습니다 — 떠 있던 프로세스를 봤습니다(고친 코드가 아닐 수 있습니다)')
    expect(rep.text).toContain('떠 있던 것')
    writeFileSync(gate, '')
    expect((await call).status).toBe('ok')
    expect(existsSync(gate)).toBe(true)
  })
})
