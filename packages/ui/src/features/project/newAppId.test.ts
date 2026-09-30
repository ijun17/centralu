import { describe, expect, it } from 'vitest'
import { newAppIdProblem } from '@cc/protocol'
import { appIdHint, deriveAppId } from './newAppId.js'

describe('deriveAppId — the id derived from a name', () => {
  it('derives a shape the validation will pass', () => {
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

  it('truncates at 32 characters and strips a trailing hyphen left by truncation', () => {
    const id = deriveAppId('a very long name for a small app that counts things')
    expect(id).toBe('a-very-long-name-for-a-small-app')
    expect(id.length).toBeLessThanOrEqual(32)
    expect(deriveAppId(`${'x'.repeat(31)} y`)).toBe('x'.repeat(31))
  })

  it('is an empty id for a name that cannot be converted to letters and digits — nothing is fabricated', () => {
    expect(deriveAppId('리소스 검색')).toBe('')
    expect(deriveAppId('---')).toBe('')
  })

  it('lets validation block a reserved word or an app- prefix even after deriving it — the derivation does not imitate the validation', () => {
    expect(newAppIdProblem(deriveAppId('Centralu tools'))).toBe('reserved')
    expect(newAppIdProblem(deriveAppId('App store'))).toBe('server-prefix')
  })
})

describe('appIdHint — the wording shown in the dialog', () => {
  it('asks for an id when empty, and states the reason for everything else', () => {
    expect(appIdHint('', 'shape')).toBe('Give the app an id: lowercase letters, digits and hyphens.')
    expect(appIdHint('my_app', 'shape')).toContain('lowercase letters, digits and hyphens')
    expect(appIdHint('centralu-x', 'reserved')).toContain('"centralu"')
    expect(appIdHint('app-x', 'server-prefix')).toContain('"app-"')
    expect(appIdHint('control', 'builtin')).toBe('"control" is a built-in app.')
  })
})
