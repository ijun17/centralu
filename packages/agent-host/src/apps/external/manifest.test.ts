import { describe, expect, it } from 'vitest'
import { MANIFEST_VERSION, parseManifest, toolNameError } from './manifest.js'

/**
 * 매니페스트 판정 (M4 A-1). 규칙은 zod 한 벌이고, 이 테스트는 그 한 벌이 사람이 읽을
 * 이유와 함께 거절하는지, 모르는 필드는 거절하지 않는지를 본다.
 */

const base = {
  manifestVersion: MANIFEST_VERSION,
  id: 'resource-search',
  name: 'Resource search',
  version: '0.1.0',
  description: 'Finds resources',
  server: { command: 'node', args: ['server.mjs'] },
  uses: {},
}
const parse = (over: Record<string, unknown>) => parseManifest(JSON.stringify({ ...base, ...over }))

describe('매니페스트', () => {
  it('맞는 매니페스트를 읽는다 — 빠진 선택 칸은 기본값이 된다', () => {
    const r = parseManifest(JSON.stringify({ ...base, uses: undefined, server: { command: 'node' } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.server.args).toEqual([])
    expect(r.manifest.uses).toEqual({})
    expect(r.warnings).toEqual([])
  })

  it('id는 #93의 이름 규칙을 그대로 따른다 — 밑줄·대문자·예약어를 거절한다', () => {
    for (const id of ['has_underscore', 'Upper', 'centralu-x', 'centralu', '-leading', 'a'.repeat(33)]) {
      const r = parse({ id })
      expect(r.ok, id).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^id: /)
    }
    expect(parse({ id: 'a-1' }).ok).toBe(true)
  })

  it('모르는 필드는 경고만 한다 (위·server·uses·csp 모두)', () => {
    const r = parse({
      futureField: 1,
      server: { command: 'node', args: [], cwd: 'x' },
      uses: { agent: true, clipboard: true },
      csp: { connectDomains: ['https://api.example.com'], scriptDomains: [] },
    })
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([
      'unknown field, ignored: futureField',
      'unknown field, ignored: server.cwd',
      'unknown field, ignored: uses.clipboard',
      'unknown field, ignored: csp.scriptDomains',
    ])
  })

  it('빠진 필수 칸과 틀린 형은 칸 이름과 함께 말한다', () => {
    const r = parseManifest(JSON.stringify({ ...base, name: undefined, version: 3 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('name: missing')
    expect(r.error).toMatch(/version: (?!missing)/)
  })

  it('모르는 manifestVersion은 읽지 않는다 — 뜻이 바뀐 필드를 옛 뜻으로 실행하지 않게', () => {
    const r = parse({ manifestVersion: MANIFEST_VERSION + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('update Centralu')
  })

  it('home은 도구 이름 규칙을 따른다 (`__` 금지)', () => {
    expect(parse({ home: 'open' }).ok).toBe(true)
    const r = parse({ home: 'open__panel' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^home: .*__/)
  })

  it('비밀 이름은 환경 변수 이름이고, Centralu와 host의 이름을 가져가지 못한다', () => {
    expect(parse({ secrets: ['GITHUB_TOKEN'] }).ok).toBe(true)
    for (const s of ['lower', 'CENTRALU_APP_DATA', 'CC_HOST_TOKEN', '1ABC']) {
      expect(parse({ secrets: [s] }).ok, s).toBe(false)
    }
  })

  it('view.origin은 opaque가 기본이고, app을 요청할 수 있으며, 모르는 값은 거절한다', () => {
    const none = parse({})
    expect(none.ok && none.manifest.view).toBeUndefined()
    const empty = parse({ view: {} })
    expect(empty.ok && empty.manifest.view).toEqual({ origin: 'opaque' })
    const app = parse({ view: { origin: 'app' } })
    expect(app.ok && app.manifest.view).toEqual({ origin: 'app' })
    // 오타는 기본값으로 조용히 읽히지 않는다 — 앱이 서지 않고 이유가 칸 이름과 함께 나온다
    for (const origin of ['per-app', 'App', true, null]) {
      const r = parse({ view: { origin } })
      expect(r.ok, String(origin)).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/^view\.origin: /)
    }
    // 모르는 필드는 여느 칸처럼 경고만
    const extra = parse({ view: { origin: 'app', pinned: true } })
    expect(extra.ok).toBe(true)
    expect(extra.warnings).toEqual(['unknown field, ignored: view.pinned'])
  })

  it('uses.agent는 true 또는 도구 이름의 목록이다 (D-1)', () => {
    expect(parse({ uses: { agent: true } }).ok).toBe(true)
    expect(parse({ uses: { agent: ['claude', 'codex'] } }).ok).toBe(true)
    const bad = parse({ uses: { agent: ['Claude Code'] } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('not the shape of an agent tool name')
  })

  it('uses.host는 닫힌 목록이다 — 모르는 이름은 경고(부탁하면 거절), 모양이 틀린 이름은 오류 (D-3)', () => {
    const known = parse({ uses: { host: ['sessions.list', 'git.status'] } })
    expect(known).toMatchObject({ ok: true, warnings: [] })
    const unknown = parse({ uses: { host: ['git.stat'] } })
    expect(unknown.ok).toBe(true)
    expect(unknown.warnings).toEqual(['uses.host: Centralu has no capability "git.stat" — it can give: sessions.list, git.status (asking for it is refused)'])
    expect(parse({ uses: { host: ['Git Status'] } }).ok).toBe(false)
  })

  it('uses.apps의 id도 같은 이름 규칙을 따른다', () => {
    expect(parse({ uses: { apps: ['other-app'] } }).ok).toBe(true)
    expect(parse({ uses: { apps: ['Other_App'] } }).ok).toBe(false)
  })

  it('JSON이 아니거나 객체가 아니면 그 이유를 말한다', () => {
    const a = parseManifest('{ nope')
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('is not JSON')
    const b = parseManifest('[]')
    expect(b.ok).toBe(false)
  })
})

describe('도구 이름 규칙', () => {
  it('`__`를 거절하고 나머지는 받는다', () => {
    expect(toolNameError('get_state')).toBeNull()
    expect(toolNameError('a__b')).toMatch(/__/)
    expect(toolNameError('')).not.toBeNull()
  })
})
