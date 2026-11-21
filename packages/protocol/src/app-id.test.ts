import { describe, expect, it } from 'vitest'
import { APP_ID_MAX_LENGTH, newAppIdProblem, serverNameProblem } from './app-id.js'

// The app id rule the host and the "new app" window share. The host's wording is tested in apps/contract.test.ts,
// the window's in ui's newAppId.test.ts.
describe('serverNameProblem', () => {
  it('character rule: lowercase, digits, hyphens, not starting with a hyphen, up to 32 characters', () => {
    for (const ok of ['notes', 'a', '0', 'resource-search', 'a-b-c', 'x'.repeat(APP_ID_MAX_LENGTH)]) {
      expect(serverNameProblem(ok), ok).toBeNull()
    }
    for (const bad of [
      '',
      '-notes',
      'Notes',
      'my_app',
      'a__b',
      'a b',
      'x'.repeat(APP_ID_MAX_LENGTH + 1),
      '노트',
      'notes!',
    ]) {
      expect(serverNameProblem(bad), bad).toBe('shape')
    }
  })

  it('checks the reserved word before the character rule — case-insensitive and ignoring surrounding whitespace', () => {
    for (const name of ['centralu', 'centralu-tools', 'centralu__pw', 'Centralu', ' CENTRALU x']) {
      expect(serverNameProblem(name), name).toBe('reserved')
    }
  })
})

describe('newAppIdProblem', () => {
  it('a new name may not have the app- prefix — discovery is not blocked (serverNameProblem passes it)', () => {
    expect(newAppIdProblem('app-notes')).toBe('server-prefix')
    expect(serverNameProblem('app-notes')).toBeNull()
    expect(newAppIdProblem('apps')).toBeNull()
    expect(newAppIdProblem('my-app-notes')).toBeNull()
  })

  it('a reserved id cannot be used — the retired control app by default, or the list the caller passes in', () => {
    expect(newAppIdProblem('control')).toBe('builtin')
    expect(newAppIdProblem('notes', ['notes'])).toBe('builtin')
    expect(newAppIdProblem('control', [])).toBeNull()
  })

  it('an earlier judgment wins — order is reserved, shape, prefix, builtin', () => {
    expect(newAppIdProblem('centralu', ['centralu'])).toBe('reserved')
    expect(newAppIdProblem('App-x', ['App-x'])).toBe('shape')
    expect(newAppIdProblem('app-x', ['app-x'])).toBe('server-prefix')
  })
})
