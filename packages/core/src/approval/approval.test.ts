import { describe, expect, it } from 'vitest'
import type { ApprovalDetail } from '@cc/protocol'
import { findMatchingRule, matchesRule, previewMatches, suggestMatcher } from './approval.js'

const cmd = (command: string): ApprovalDetail => ({ kind: 'command', command, cwd: '/p' })

describe('matching "always allow" rules', () => {
  it('without a pattern, only an exact match', () => {
    expect(matchesRule('npm test', 'npm test')).toBe(true)
    expect(matchesRule('npm test --watch', 'npm test')).toBe(false)
  })

  it('supports the * pattern', () => {
    expect(matchesRule('npm test --watch', 'npm test*')).toBe(true)
    expect(matchesRule('npm install', 'npm test*')).toBe(false)
  })

  it('regex metacharacters are escaped (so a rule does not apply where it should not)', () => {
    expect(matchesRule('rm -rf /', 'rm -rf .')).toBe(false)
    expect(matchesRule('a.b', 'a.b')).toBe(true)
    expect(matchesRule('axb', 'a.b')).toBe(false)
  })

  it('a session rule does not apply to another session', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: 'npm*' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's1', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's2', projectId: 'p1' })).toBeNull()
  })

  it('a project rule applies to every session in that project', () => {
    const rules = [{ scope: 'project' as const, projectId: 'p1', matcher: 'npm*' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p2' })).toBeNull()
  })

  it('command rules do not apply to file edits', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: '*' }]
    const detail: ApprovalDetail = { kind: 'file_edit', path: 'a.ts', diffPreview: '', multi: false }
    expect(findMatchingRule(detail, rules, { sessionId: 's1', projectId: 'p1' })).toBeNull()
  })
})

describe('rule preview (making the result visible instead of limiting what can be expressed)', () => {
  it('shows the matching commands from the history', () => {
    const history = ['npm test', 'npm test:watch', 'npm install', 'npm test']
    expect(previewMatches('npm test*', history)).toEqual(['npm test', 'npm test:watch'])
  })

  it('the suggestion is pinned to the whole approved command — widening it is up to the user', () => {
    expect(suggestMatcher('npm test --watch')).toBe('npm test --watch')
    expect(suggestMatcher('ls')).toBe('ls')
  })

  it('the suggested pattern matches the approved command itself', () => {
    for (const command of ['npm test --watch', 'rm -rf node_modules', 'ls']) {
      expect(matchesRule(command, suggestMatcher(command))).toBe(true)
    }
  })

  it('does not suggest a dangerous generalisation — approving rm -rf node_modules does not open up rm -rf /', () => {
    const suggested = suggestMatcher('rm -rf node_modules')
    expect(matchesRule('rm -rf /', suggested)).toBe(false)
    // Appending * is not safe either — chaining breaks through it
    expect(matchesRule('rm -rf node_modules; rm -rf /', suggested)).toBe(false)
  })
})
