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
      '모르는 필드는 무시합니다: futureField',
      '모르는 필드는 무시합니다: server.cwd',
      '모르는 필드는 무시합니다: uses.clipboard',
      '모르는 필드는 무시합니다: csp.scriptDomains',
    ])
  })

  it('빠진 필수 칸과 틀린 형은 칸 이름과 함께 말한다', () => {
    const r = parseManifest(JSON.stringify({ ...base, name: undefined, version: 3 }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('name: 빠졌습니다')
    expect(r.error).toMatch(/version: (?!빠졌습니다)/)
  })

  it('모르는 manifestVersion은 읽지 않는다 — 뜻이 바뀐 필드를 옛 뜻으로 실행하지 않게', () => {
    const r = parse({ manifestVersion: MANIFEST_VERSION + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Centralu를 올리거나')
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

  it('uses.apps의 id도 같은 이름 규칙을 따른다', () => {
    expect(parse({ uses: { apps: ['other-app'] } }).ok).toBe(true)
    expect(parse({ uses: { apps: ['Other_App'] } }).ok).toBe(false)
  })

  it('JSON이 아니거나 객체가 아니면 그 이유를 말한다', () => {
    const a = parseManifest('{ nope')
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error).toContain('JSON이 아닙니다')
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
