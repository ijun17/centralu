import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serveBroker } from './broker.js'
import { ExternalApps, resultText, type AppRef } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { StreamTransport } from './stream-transport.js'
import { until } from './test-helpers.js'

/**
 * 앱 템플릿과 그 런타임 (M4 C-1) — 템플릿으로 펼친 앱을 **진짜 `node`로** 띄워 본다.
 *
 * 스파이크 S-6이 통과한 것(설치 없이 뜬다)과, 그때 에이전트가 걸려 넘어진 것(시작 오류가 표준에러에
 * 한 줄도 없이 -32603만 돌아왔다, 압축된 런타임 안의 스택은 읽을 수 없었다)을 제품의 템플릿에 대고 본다.
 */

const BUILD_SCRIPT = fileURLToPath(new URL('../../../scripts/build-app-runtime.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-template-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  rmSync(root, { recursive: true, force: true })
})

/** 템플릿을 프로젝트 앱 자리에 펼친다 — 만들기(C-1b)가 쓰는 것과 같은 함수다 */
function scaffold(id: string, name = 'Counter'): string {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name, description: `${name} app` })
  return dir
}

function runtime(timing: Record<string, number> = {}) {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  return rt
}
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })

/** 템플릿 런타임을 쓰는 server.mjs — 틀린 앱·특별한 앱을 만들 때 템플릿의 것을 갈아 끼운다 */
const serverUsing = (body: string) => `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'
${body}
`

describe('펼친 템플릿은 node 하나로 뜬다', () => {
  it('깨끗한 사본 — 위쪽에 node_modules도 package.json도 없이, 환경은 PATH뿐 — 이 도구 목록에 답하고 상태를 데이터 폴더에 남긴다', async () => {
    const dir = scaffold('counter')
    // 사본 위 어디에도 설치의 흔적이 없어야 "설치 없이"가 참이다
    const above: string[] = []
    for (let d = dir; ; d = dirname(d)) {
      for (const f of ['node_modules', 'package.json']) if (existsSync(join(d, f))) above.push(join(d, f))
      if (d === dirname(d)) break
    }
    expect(above).toEqual([])
    const src = readFileSync(join(dir, 'server.mjs'), 'utf8')
    const bare = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!).filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
    expect(bare).toEqual([])

    const data = join(root, 'app-data')
    const connect = async () => {
      const c = new Client({ name: 'host', version: '0' }, { versionNegotiation: { mode: 'auto' } })
      await c.connect(new StdioClientTransport({ command: 'node', args: ['--enable-source-maps', 'server.mjs'], cwd: dir, env: { PATH: process.env.PATH!, CENTRALU_APP_DATA: data }, stderr: 'pipe' }))
      return c
    }
    const c = await connect()
    const tools = (await c.listTools()).tools
    expect(tools.map((t) => t.name)).toEqual(['show', 'increment', 'reset'])
    const show = tools.find((t) => t.name === 'show')!
    expect(show._meta).toMatchObject({ ui: { resourceUri: 'ui://counter/index.html' } })
    expect(show.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === 'reset')!._meta).toMatchObject({ ui: { visibility: ['app'] } })

    const read = await c.readResource({ uri: 'ui://counter/index.html' })
    const html = (read.contents[0] as { text: string }).text
    expect(read.contents[0]!.mimeType).toBe('text/html;profile=mcp-app')
    // 브리지가 끼워 넣어졌다 — 자리표시 태그는 남지 않는다
    expect(html).toContain('McpApp')
    expect(html).not.toContain('centralu:mcp-app.js"></script>')
    expect(html).toContain('centralu/notifications/changed')

    expect((await c.callTool({ name: 'increment', arguments: { by: 2 } })).structuredContent).toEqual({ count: 2 })
    await c.close()
    // 상태는 앱 폴더가 아니라 데이터 폴더에 있다 — 다시 띄워도 남는다
    expect(JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))).toEqual({ count: 2 })
    expect(readdirSync(dir).sort()).toEqual(['.gitattributes', 'AGENTS.md', 'CLAUDE.md', 'centralu.app.json', 'runtime', 'server.mjs', 'ui'])
    const again = await connect()
    expect((await again.callTool({ name: 'show', arguments: {} })).structuredContent).toEqual({ count: 2 })
    await again.close()
  })

  it('펼친 폴더는 이름을 채우고, 생성물 표시를 남기고, 런타임은 바이트 그대로다', () => {
    const dir = scaffold('notes', 'Team <Notes> "board"')
    const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8'))
    expect(manifest).toMatchObject({ id: 'notes', name: 'Team <Notes> "board"', home: 'show' })
    expect(readFileSync(join(dir, 'ui', 'index.html'), 'utf8')).toContain('<title>Team &lt;Notes&gt; &quot;board&quot;</title>')
    expect(readFileSync(join(dir, 'server.mjs'), 'utf8')).toContain("const UI = 'ui://notes/index.html'")
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toMatch(/^# Team <Notes> "board" — a Centralu app/)
    expect(readFileSync(join(dir, '.gitattributes'), 'utf8')).toContain('runtime/** linguist-generated=true -diff')
    for (const f of ['centralu-app-runtime.mjs', 'centralu-app-runtime.mjs.map', 'mcp-app.js', 'THIRD_PARTY_LICENSES.txt']) {
      expect(readFileSync(join(dir, 'runtime', f)).equals(readFileSync(join(appTemplateDir(), 'runtime', f)))).toBe(true)
    }
    // 자리표시가 남은 파일이 없다
    const leftovers = ['server.mjs', 'AGENTS.md', 'ui/index.html', 'centralu.app.json'].filter((f) => readFileSync(join(dir, f), 'utf8').includes('{{'))
    expect(leftovers).toEqual([])
  })
})

describe('틀린 앱은 이유를 말한다', () => {
  it('도구를 등록하다 던진 server.mjs — 표준에러에 그 오류가 남고, 앱은 그 이유를 든 채 멈춘다', async () => {
    const dir = scaffold('broken')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'broken', version: '0' }, { capabilities: { tools: {} } })
  throw new Error('boom while registering tools')
})`),
    )
    const r = runtime()
    for (let i = 0; i < 3; i++) await expect(r.tools(ref('broken'))).rejects.toThrow(/boom while registering tools/)
    const info = r.list().find((a) => a.appId === 'broken')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('--- stderr (last lines) ---')
    expect(info.error).toContain('the server could not start — setting up the server threw')
    expect(info.error).toContain('boom while registering tools')
    // 앱 코드의 오류는 파일:줄로 남는다
    expect(info.error).toMatch(/server\.mjs:\d+/)
  })

  it('맨 위에서 던진 server.mjs — 뜨기 전에 끝났다는 것과 그 오류가 이유가 된다', async () => {
    const dir = scaffold('toplevel')
    writeFileSync(join(dir, 'server.mjs'), serverUsing(`throw new Error('cannot read my config')`))
    const r = runtime({ maxFailures: 1 })
    await expect(r.tools(ref('toplevel'))).rejects.toThrow(/exited before it was ready/)
    const info = r.list().find((a) => a.appId === 'toplevel')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('cannot read my config')
  })

  it('압축된 런타임 안에서 난 오류도 원래 파일의 이름으로 읽힌다 (소스맵)', async () => {
    scaffold('mapped')
    // 데이터 폴더의 상태 파일이 깨졌다 — 오류는 런타임의 readJson 안에서 난다
    const data = join(dataRoot, 'app-data', 'p1', 'mapped')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'state.json'), '{ not json')
    const r = runtime({ maxFailures: 1 })
    await expect(r.tools(ref('mapped'))).rejects.toThrow()
    const error = r.list().find((a) => a.appId === 'mapped')!.error!
    expect(error).toContain('is not valid JSON')
    expect(error).toMatch(/vendored\/centralu\/centralu\.mjs:\d+/)
    // 던진 줄도 원래 줄로 찍힌다 — 압축된 한 줄(수백 자)이 표준에러 끝부분의 한 칸을 먹지 않는다
    expect(error).toContain('throw new Error(`centralu.readJson:')
    expect(error).not.toContain('centralu-app-runtime.mjs')
  })
})

describe('도우미', () => {
  it('화면 없는 도구도 받는다 — 입력 스키마가 있든 없든', async () => {
    const dir = scaffold('plain')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'plain', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'add', { description: 'Add', inputSchema: z.object({ a: z.number(), b: z.number() }), annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }))
  centralu.tool(server, 'ping', { description: 'Ping', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  return server
})`),
    )
    const r = runtime()
    expect((await r.tools(ref('plain'))).map((t) => t.name)).toEqual(['add', 'ping'])
    const add = await r.call(ref('plain'), 'add', { a: 2, b: 3 }, { kind: 'session', sessionId: 's1' })
    expect([add.status, resultText(add.result!)]).toEqual(['ok', '5'])
    const ping = await r.call(ref('plain'), 'ping', {}, { kind: 'session', sessionId: 's1' })
    expect([ping.status, resultText(ping.result!)]).toEqual(['ok', 'pong'])
  })

  it('centralu.agent는 중개가 아직 없다는 답을 그대로 올린다 — 도구의 실패 결과와 표준에러 둘 다에', async () => {
    const dir = scaffold('asker')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'asker', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'summarize', { description: 'Summarize', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: 'text', text: await centralu.agent('summarize: ' + text, { schema: { type: 'object' } }) }] }))
  centralu.tool(server, 'ask_other', { description: 'Ask another app', annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: 'text', text: String(await centralu.callApp('other', 'echo', { text: 'hi' })) }] }))
  return server
})`),
    )
    const r = runtime()
    const out = await r.call(ref('asker'), 'summarize', { text: 'hello' }, { kind: 'session', sessionId: 's1' })
    expect(out.status).toBe('error')
    expect(resultText(out.result!)).toBe(
      "centralu.agent() failed: run_agent is not available yet — the broker's tools arrive with Centralu M4 section D",
    )
    const other = await r.call(ref('asker'), 'ask_other', {}, { kind: 'session', sessionId: 's1' })
    expect(resultText(other.result!)).toContain('centralu.callApp("other", "echo") failed: call_app is not available yet')
    const log = readFileSync(join(dataRoot, 'app-logs', 'p1', 'asker.log'), 'utf8')
    expect(log).toContain('[centralu] centralu.agent() failed: run_agent is not available yet')
  })
})

describe('끝내기 약속 (S-5)', () => {
  it('중개를 한 번 쓴 앱도 표준 입력이 닫히면 끝난다 — host가 fd 3을 닫지 않아도', async () => {
    const dir = scaffold('closer')
    writeFileSync(
      join(dir, 'server.mjs'),
      serverUsing(`serveStdio(() => {
  const server = new McpServer({ name: 'closer', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'ask', { description: 'Ask', annotations: { readOnlyHint: true } }, async () => {
    try { await centralu.agent('x') } catch (e) { return { content: [{ type: 'text', text: e.message }] } }
    return { content: [{ type: 'text', text: 'no error?' }] }
  })
  return server
})`),
    )
    const child = spawn('node', ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH! } })
    const fd3 = child.stdio[3] as Socket
    // fd 3 위에는 host의 진짜 중개 서버 — 어느 실행 id든 열려 있다고 답한다
    const closeBroker = serveBroker(fd3, { openRun: () => new AbortController().signal, note: () => {} })
    let exited = false
    child.on('exit', () => (exited = true))
    try {
      const c = new Client({ name: 'host', version: '0' }, { versionNegotiation: { mode: 'auto' } })
      await c.connect(new StreamTransport(child.stdout!, child.stdin!, { pid: child.pid ?? null }))
      const r = await c.callTool({ name: 'ask', arguments: {}, _meta: { 'centralu/runId': 'run_test' } })
      expect(resultText(r as never)).toContain('run_agent is not available yet')

      // 표준 입력만 닫는다 — fd 3은 host 쪽에서 열어 둔 채로
      child.stdin!.end()
      await until(() => exited, (x) => x, 3_000)
    } finally {
      closeBroker()
      fd3.destroy()
      if (!exited) child.kill('SIGKILL')
    }
  })
})

describe('런타임은 저장소의 스크립트가 같은 바이트로 다시 만든다', () => {
  it('커밋된 런타임 = 지금 소스를 판을 못 박은 도구로 묶은 것 (MIT만)', () => {
    const out = execFileSync(process.execPath, [BUILD_SCRIPT, '--check'], { encoding: 'utf8' })
    expect(out).toContain('up to date')
    const licenses = readFileSync(join(appTemplateDir(), 'runtime', 'THIRD_PARTY_LICENSES.txt'), 'utf8')
    const heads = [...licenses.matchAll(/^==== (.+) \((.+)\) ====$/gm)].map((m) => m[2])
    expect(heads.length).toBeGreaterThan(3)
    expect(new Set(heads)).toEqual(new Set(['MIT']))
  })
})
