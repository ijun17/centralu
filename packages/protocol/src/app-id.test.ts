import { describe, expect, it } from 'vitest'
import { APP_ID_MAX_LENGTH, newAppIdProblem, serverNameProblem } from './app-id.js'

/**
 * 앱 id의 규칙 (#93, M4 C-1) — host와 "새 앱" 창이 같은 판정을 쓴다. 여기서는 판정 자체를 본다: host 쪽 말(한국어
 * 이유)은 apps/contract.ts의 시험들이, 창의 말은 ui의 newAppId.test.ts가 본다.
 */
describe('serverNameProblem', () => {
  it('글자 규칙: 소문자·숫자·하이픈, 첫 글자는 하이픈이 아니고, 32자까지', () => {
    for (const ok of ['notes', 'a', '0', 'resource-search', 'a-b-c', 'x'.repeat(APP_ID_MAX_LENGTH)]) {
      expect(serverNameProblem(ok), ok).toBeNull()
    }
    for (const bad of ['', '-notes', 'Notes', 'my_app', 'a__b', 'a b', 'x'.repeat(APP_ID_MAX_LENGTH + 1), '노트', 'notes!']) {
      expect(serverNameProblem(bad), bad).toBe('shape')
    }
  })

  it('예약어를 글자 규칙보다 먼저 본다 — 대소문자와 앞뒤 공백을 가리지 않는다', () => {
    for (const name of ['centralu', 'centralu-tools', 'centralu__pw', 'Centralu', ' CENTRALU x']) {
      expect(serverNameProblem(name), name).toBe('reserved')
    }
  })
})

describe('newAppIdProblem', () => {
  it('새 이름은 app- 머리를 가질 수 없다 — 발견은 막지 않는다(serverNameProblem은 통과한다)', () => {
    expect(newAppIdProblem('app-notes')).toBe('server-prefix')
    expect(serverNameProblem('app-notes')).toBeNull()
    expect(newAppIdProblem('apps')).toBeNull()
    expect(newAppIdProblem('my-app-notes')).toBeNull()
  })

  it('부르는 쪽이 넘긴 내장 앱의 id는 쓸 수 없다', () => {
    expect(newAppIdProblem('control', ['control'])).toBe('builtin')
    expect(newAppIdProblem('control')).toBeNull()
  })

  it('앞의 판정이 이긴다 — 예약어, 글자, 머리, 내장 순', () => {
    expect(newAppIdProblem('centralu', ['centralu'])).toBe('reserved')
    expect(newAppIdProblem('App-x', ['App-x'])).toBe('shape')
    expect(newAppIdProblem('app-x', ['app-x'])).toBe('server-prefix')
  })
})
