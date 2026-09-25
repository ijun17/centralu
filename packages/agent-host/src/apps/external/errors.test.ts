import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { until } from './test-helpers.js'

/**
 * 오류가 만드는 쪽에 닿는다 — host의 절반 (M4 C-6). 앱이 뜨지 못함·죽음·도구 실패를 앱마다 묶어 두고, 물으면
 * 답한다. 보내지는 않는다. 템플릿의 런타임을 쓰는 진짜 앱으로 본다.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-errors-')))
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
const SESSION = { kind: 'session' as const, sessionId: 's1' }

function make() {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, maxFailures: 5, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

function app(id: string, server: string, manifest?: (m: Record<string, unknown>) => void): void {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: `App ${id}`, description: id })
  writeFileSync(join(dir, 'server.mjs'), `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'\n${server}\n`)
  if (manifest) {
    const f = join(dir, 'centralu.app.json')
    const m = JSON.parse(readFileSync(f, 'utf8'))
    manifest(m)
    writeFileSync(f, JSON.stringify(m, null, 2))
  }
}
const tools = (body: string) => `serveStdio(() => {
  const server = new McpServer({ name: 'x', version: '0' }, { capabilities: { tools: {} } })
  ${body}
  return server
})`

describe('앱마다 최근 오류를 묶어 둔다', () => {
  it('뜨지 못했다 — 이유와 그때의 표준에러', async () => {
    app('broken', `serveStdio(() => { throw new Error('forgot to define the tools') })`)
    const r = make()
    const t0 = Date.now()
    await expect(r.tools(ref('broken'))).rejects.toThrow()
    const { latest, recent } = r.errors(ref('broken'))
    expect(recent).toHaveLength(1)
    expect(latest).toMatchObject({ kind: 'start', tool: null, args: null, runId: null })
    expect(latest!.at).toBeGreaterThanOrEqual(t0)
    expect(latest!.message).not.toContain('--- stderr') // 이유와 표준에러는 따로 싣는다
    expect(latest!.stderr.join('\n')).toContain('forgot to define the tools')
    expect(latest!.text).toMatch(/^App App broken \(p1\/broken\): the app could not start \(\d{4}-/)
    expect(latest!.text).toContain('stderr (last lines):')
  })

  it('맨 위에서 던지고 끝났다 — 끝난 모양이 이유다', async () => {
    app('exits', `throw new Error('config.json is missing')`)
    const r = make()
    await expect(r.tools(ref('exits'))).rejects.toThrow()
    const { latest } = r.errors(ref('exits'))
    expect(latest).toMatchObject({ kind: 'start', message: 'exited before it was ready (code 1)' })
    expect(latest!.stderr.join('\n')).toContain('Error: config.json is missing')
  })

  it('도구가 던졌다 — 어느 도구가, 어떤 인자로, 어디서(스택은 server.mjs의 줄)', async () => {
    app('thrower', tools(`centralu.tool(server, 'save', { description: 'Save', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: false } }, async ({ text }) => {
    throw new Error('cannot save: ' + text)
  })`))
    const r = make()
    const out = await r.call(ref('thrower'), 'save', { text: 'hello' }, SESSION)
    expect(out.status).toBe('error')
    const latest = await until(() => r.errors(ref('thrower')).latest, (b) => !!b && b.stderr.some((l) => l.includes('server.mjs:')))
    expect(latest).toMatchObject({ kind: 'tool', tool: 'save', args: '{"text":"hello"}', runId: out.runId, message: 'cannot save: hello' })
    expect(latest!.stderr.join('\n')).toContain('[thrower] tool save threw: Error: cannot save: hello')
    expect(latest!.text).toContain('Tool: save\nArguments: {"text":"hello"}')
  })

  it('호출 중에 죽었다 — 도구의 실패와 프로세스의 끝이 둘 다 남고, 최근 것이 끝이다', async () => {
    app('dies', tools(`centralu.tool(server, 'boom', { description: 'Dies', annotations: { readOnlyHint: true } }, async () => {
    console.error('about to run out of memory, pretending')
    process.exit(7)
  })`))
    const r = make()
    const out = await r.call(ref('dies'), 'boom', {}, SESSION)
    expect(out.status).toBe('error')
    const recent = await until(() => r.errors(ref('dies')).recent, (l) => l.some((b) => b.kind === 'crash'))
    const crash = recent.find((b) => b.kind === 'crash')!
    expect(crash.message).toBe('exited (code 7)')
    expect(crash.stderr).toContain('about to run out of memory, pretending')
    expect(recent.find((b) => b.kind === 'tool')).toMatchObject({ tool: 'boom' })
  })

  it('비밀은 이유·인자·표준에러 어디에도 남지 않는다', async () => {
    app(
      'secretive',
      tools(`centralu.tool(server, 'call_api', { description: 'Calls', inputSchema: z.object({ token: z.string() }), annotations: { readOnlyHint: true } }, async () => {
    console.error('using key ' + process.env.API_KEY)
    throw new Error('401 for key ' + process.env.API_KEY)
  })`),
      (m) => (m.secrets = ['API_KEY']),
    )
    const r = make()
    r.setSecret(ref('secretive'), 'API_KEY', 'sk-live-123456')
    await r.call(ref('secretive'), 'call_api', { token: 'sk-live-123456' }, SESSION)
    const latest = await until(() => r.errors(ref('secretive')).latest, (b) => !!b && b.stderr.some((l) => l.includes('using key')))
    expect(JSON.stringify(latest)).not.toContain('sk-live-123456')
    expect(latest!.message).toBe('401 for key [redacted:API_KEY]')
    expect(latest!.args).toBe('{"token":"[redacted:API_KEY]"}')
    expect(latest!.stderr).toContain('using key [redacted:API_KEY]')
  })

  it('정책의 거절과 성공은 오류가 아니다 — 최근 것만 든다', async () => {
    app('mixed', tools(`centralu.tool(server, 'ok', { description: 'Fine', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'fine' }] }))
  centralu.tool(server, 'screen_only', { description: 'App only', annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ['app'] } } }, async () => ({ content: [] }))
  centralu.tool(server, 'fail', { description: 'Fails', inputSchema: z.object({ n: z.number() }), annotations: { readOnlyHint: true } }, async ({ n }) => ({ content: [{ type: 'text', text: 'failure ' + n }], isError: true }))`))
    const r = make()
    expect((await r.call(ref('mixed'), 'ok', {}, SESSION)).status).toBe('ok')
    expect((await r.call(ref('mixed'), 'screen_only', {}, SESSION)).status).toBe('rejected')
    expect(r.errors(ref('mixed'))).toEqual({ latest: null, recent: [] })
    for (let n = 1; n <= 12; n++) await r.call(ref('mixed'), 'fail', { n }, SESSION)
    const { latest, recent } = r.errors(ref('mixed'))
    expect(recent).toHaveLength(10)
    expect(latest!.message).toBe('failure 12')
    expect(recent.at(-1)!.message).toBe('failure 3')
  })
})

describe('만드는 세션에 보낸 묶음 (C-6)', () => {
  it('보냈다는 표시는 한 번만 서고, 표준에러를 다시 담아 묶음이 갈아 끼워져도 남으며, 지우면 다시 보낼 수 있다', async () => {
    // 답 뒤에 표준에러가 한 줄 더 온다 — 묶음이 그 줄을 다시 담아 **새 객체로 갈아 끼워지는** 길을 반드시 지나게
    app('thrower', tools(`centralu.tool(server, 'save', { description: 'Save', annotations: { readOnlyHint: false } }, async () => {
    setTimeout(() => console.error('written after the reply'), 30)
    throw new Error('cannot save')
  })`))
    const r = make()
    await r.call(ref('thrower'), 'save', {}, SESSION)
    const at = r.errors(ref('thrower')).latest!.at
    expect(r.errors(ref('thrower')).latest?.sentAt).toBeNull()
    // 실패 바로 뒤 — 표준에러를 다시 담는 150ms 전에 보낸다
    expect(r.markErrorSent(ref('thrower'), at)).toMatchObject({ kind: 'tool', at })
    expect(r.markErrorSent(ref('thrower'), at)).toBe('sent')
    await new Promise((res) => setTimeout(res, 300))
    expect(r.errors(ref('thrower')).latest).toMatchObject({ at, sentAt: expect.any(Number) })
    expect(r.errors(ref('thrower')).latest!.stderr.join('\n')).toContain('written after the reply')
    r.unmarkErrorSent(ref('thrower'), at)
    expect(r.errors(ref('thrower')).latest?.sentAt).toBeNull()
    expect(r.markErrorSent(ref('thrower'), at + 1)).toBeNull()
  })
})

describe('목록의 lastErrorAt (C-6)', () => {
  it('읽기 전용 도구가 던져도 목록의 마지막 오류 때가 바뀌고 목록을 듣는 쪽이 깨어난다 — "바뀌었다"는 내지 않는다', async () => {
    app('reader', tools(`centralu.tool(server, 'get', { description: 'Read', annotations: { readOnlyHint: true } }, async () => {
    throw new Error('cannot read')
  })`))
    const changed: unknown[] = []
    rt = new ExternalApps({
      projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
      dataRoot,
      reservedIds: [],
      emitChanged: (ref) => changed.push(ref),
      timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, maxFailures: 5, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    })
    rt.refresh()
    await rt.tools(ref('reader'))
    const info = () => rt.list().find((a) => a.appId === 'reader')!
    expect(info().lastErrorAt).toBeUndefined()
    let heard = 0
    rt.onAppsChanged(() => void heard++)

    const out = await rt.call(ref('reader'), 'get', {}, SESSION)
    expect(out.status).toBe('error')
    await until(() => heard, (n) => n > 0)
    expect(info().lastErrorAt).toBe(rt.errors(ref('reader')).latest!.at)
    expect(changed).toEqual([])
  })
})
