import { describe, expect, it } from 'vitest'
import { newAppIdProblem } from '@cc/protocol'
import { appIdHint, deriveAppId } from './newAppId.js'

describe('deriveAppId — 이름에서 짓는 id', () => {
  it('판정이 통과시킬 모양으로 짓는다', () => {
    const cases: [string, string][] = [
      ['Team Notes', 'team-notes'],
      ['  Resource   search!! ', 'resource-search'],
      ['Café & Tea', 'cafe-tea'],
      ['API_key helper', 'api-key-helper'],
      ['v2.0 dashboard', 'v2-0-dashboard'],
    ]
    for (const [name, id] of cases) {
      expect(deriveAppId(name), name).toBe(id)
      expect(newAppIdProblem(id), id).toBeNull()
    }
  })

  it('32자에서 자르고, 자른 끝의 하이픈은 뗀다', () => {
    const id = deriveAppId('a very long name for a small app that counts things')
    expect(id).toBe('a-very-long-name-for-a-small-app')
    expect(id.length).toBeLessThanOrEqual(32)
    expect(deriveAppId(`${'x'.repeat(31)} y`)).toBe('x'.repeat(31))
  })

  it('영숫자로 바꿀 수 없는 이름은 빈 id다 — 지어내지 않는다', () => {
    expect(deriveAppId('리소스 검색')).toBe('')
    expect(deriveAppId('---')).toBe('')
  })

  it('예약어·app- 머리는 지어도 판정이 막는다 — 짓는 쪽이 판정을 흉내 내지 않는다', () => {
    expect(newAppIdProblem(deriveAppId('Centralu tools'))).toBe('reserved')
    expect(newAppIdProblem(deriveAppId('App store'))).toBe('server-prefix')
  })
})

describe('appIdHint — 창의 말', () => {
  it('빈 id는 적어 달라고 하고, 나머지는 까닭을 말한다', () => {
    expect(appIdHint('', 'shape')).toBe('Give the app an id: lowercase letters, digits and hyphens.')
    expect(appIdHint('my_app', 'shape')).toContain('lowercase letters, digits and hyphens')
    expect(appIdHint('centralu-x', 'reserved')).toContain('"centralu"')
    expect(appIdHint('app-x', 'server-prefix')).toContain('"app-"')
    expect(appIdHint('control', 'builtin')).toBe('"control" is a built-in app.')
  })
})
