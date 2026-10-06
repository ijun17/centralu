import { describe, expect, it } from 'vitest'
import { AlwaysAllowRules, alwaysAllowKey } from './always-allow.js'

describe('AlwaysAllowRules', () => {
  it('allows nothing while it holds no rules', () => {
    const rules = new AlwaysAllowRules()
    expect(rules.allows('npm test')).toBe(false)
    expect(rules.allows('')).toBe(false)
  })

  it('allows a key equal to a rule without a wildcard, and nothing longer or shorter', () => {
    const rules = new AlwaysAllowRules()
    rules.add('npm test')
    expect(rules.allows('npm test')).toBe(true)
    expect(rules.allows('npm test --watch')).toBe(false)
    expect(rules.allows('npm tes')).toBe(false)
  })

  it('treats a trailing * as a prefix match', () => {
    const rules = new AlwaysAllowRules()
    rules.add('npm test*')
    expect(rules.allows('npm test')).toBe(true)
    expect(rules.allows('npm test --watch')).toBe(true)
    expect(rules.allows('npm run build')).toBe(false)
  })

  it('treats a * anywhere but the end as a literal character', () => {
    const rules = new AlwaysAllowRules()
    rules.add('npm * test')
    expect(rules.allows('npm run test')).toBe(false)
    expect(rules.allows('npm * test')).toBe(true)
  })

  it('allows a key matching any one of the rules added with addAll', () => {
    const rules = new AlwaysAllowRules()
    rules.addAll(['git status', '/repo/src/*'])
    expect(rules.allows('git status')).toBe(true)
    expect(rules.allows('/repo/src/a.ts')).toBe(true)
    expect(rules.allows('/repo/docs/a.md')).toBe(false)
  })
})

describe('alwaysAllowKey', () => {
  it('keys a command by its full text and a file edit by its path', () => {
    expect(alwaysAllowKey({ kind: 'command', command: 'npm test', cwd: '/repo' })).toBe('npm test')
    expect(alwaysAllowKey({ kind: 'file_edit', path: '/repo/a.ts', diffPreview: '', multi: false })).toBe('/repo/a.ts')
  })

  it('gives other kinds no key', () => {
    expect(alwaysAllowKey({ kind: 'other', raw: '{}' })).toBe('')
  })

  it('gives no key to a file edit whose path is the skipped placeholder, and only when asked to', () => {
    const edit = { kind: 'file_edit', path: '?', diffPreview: '', multi: false } as const
    expect(alwaysAllowKey(edit, { skipPath: '?' })).toBe('')
    expect(alwaysAllowKey(edit)).toBe('?')
  })
})
