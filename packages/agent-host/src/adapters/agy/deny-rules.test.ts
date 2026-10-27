import { describe, expect, it } from 'vitest'
import { pathsOf } from '../../os.js'
import { agySettingsPath, deniedBy, parseRule, readDenyRules, type DenyRule } from './deny-rules.js'

/**
 * The person's own `agy` deny rules (owner decision on #59, Q1). Their syntax and the file they live in were measured on
 * agy 1.4.8 (docs/plans/antigravity-adapter.md §5.2): `command(echo deny-me)` denied `echo deny-me` and
 * `echo ok; echo deny-me` and let `echo deny-me-also` run; path rules cover what is under the folder.
 */

const host = pathsOf()
const join = (...parts: string[]) => host.join(...parts)

/** A settings reader over fixed files: a missing one fails as a read does */
const reader = (files: Record<string, string>) => (path: string) =>
  path in files ? Promise.resolve(files[path]!) : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

const rules = (...texts: string[]): DenyRule[] => texts.map((t) => parseRule(t)!).filter(Boolean)

describe('reading the settings file', () => {
  it('is the file agy reads, under the home folder', () => {
    expect(agySettingsPath('/h')).toBe(join('/h', '.gemini', 'antigravity-cli', 'settings.json'))
  })

  it('reads permissions.deny and skips what is not a known rule', async () => {
    const settings = { trustedWorkspaces: ['/x'], permissions: { allow: ['command(rm)'], deny: ['command(rm -rf)', 'not-a-rule', 7, 'read_file(relative/path)', 'mcp(s/t)'] } }
    const read = await readDenyRules(reader({ '/s.json': JSON.stringify(settings) }), '/s.json')
    expect(read.map((r) => r.text)).toEqual(['command(rm -rf)', 'mcp(s/t)'])
  })

  it('gives no rules for a missing or unreadable file, one that is not JSON, or one without the list', async () => {
    const files = { '/bad.json': '{ not json', '/none.json': JSON.stringify({ permissions: { allow: ['command(*)'] } }) }
    expect(await readDenyRules(reader(files), '/missing.json')).toEqual([])
    expect(await readDenyRules(reader(files), '/bad.json')).toEqual([])
    expect(await readDenyRules(reader(files), '/none.json')).toEqual([])
    expect(await readDenyRules(() => Promise.reject(new Error('EISDIR')), '/folder.json')).toEqual([])
  })
})

describe('a command rule', () => {
  const deny = rules('command(echo deny-me)')

  it('matches the command and the command with more words, as agy did', () => {
    expect(deniedBy(deny, { command: 'echo deny-me' })?.text).toBe('command(echo deny-me)')
    expect(deniedBy(deny, { command: 'echo deny-me now' })).not.toBeNull()
  })

  it('does not match a longer word (agy ran `echo deny-me-also`)', () => {
    expect(deniedBy(deny, { command: 'echo deny-me-also' })).toBeNull()
  })

  it('matches every part of a compound command (agy denied `echo ok; echo deny-me`)', () => {
    for (const command of ['echo ok; echo deny-me', 'true && echo deny-me', 'x | echo deny-me', 'a=$(echo deny-me)', 'FOO=1 echo deny-me', '(echo deny-me)']) {
      expect(deniedBy(deny, { command }), command).not.toBeNull()
    }
  })

  it('matches the program through its path, and `command(*)` matches every command', () => {
    expect(deniedBy(rules('command(rm -rf)'), { command: '/bin/rm -rf x' })).not.toBeNull()
    expect(deniedBy(rules('command(*)'), { command: 'ls' })).not.toBeNull()
    expect(deniedBy(rules('command(*)'), { reads: ['/x'] })).toBeNull()
  })
})

describe('a path rule', () => {
  it('covers the path and what is under it, never a sibling with the same start', () => {
    const deny = rules('write_file(/p/secret)', 'read_file(/p/hidden)')
    expect(deniedBy(deny, { writes: ['/p/secret/a.txt'] })?.text).toBe('write_file(/p/secret)')
    expect(deniedBy(deny, { writes: ['/p/secret'] })).not.toBeNull()
    expect(deniedBy(deny, { writes: ['/p/secret-not/a'] })).toBeNull()
    expect(deniedBy(deny, { reads: ['/p/secret/a.txt'] })).toBeNull()
    expect(deniedBy(deny, { reads: ['/p/hidden/x'] })?.text).toBe('read_file(/p/hidden)')
  })

  it('also matches through a link, which agy itself did not (measured: a rule under /tmp missed /private/tmp)', () => {
    const deny = rules('write_file(/tmp/w)')
    expect(deniedBy(deny, { writes: ['/private/tmp/w/a'] })).toBeNull()
    expect(deniedBy(deny, { writes: ['/private/tmp/w/a'] }, new Map([['/tmp/w', '/private/tmp/w']]))).not.toBeNull()
    expect(deniedBy(deny, { writes: ['/l/a'] }, new Map([['/l/a', '/tmp/w/a']]))).not.toBeNull()
  })
})

describe('MCP and URL rules', () => {
  it('match the server and tool, `*` for either', () => {
    expect(deniedBy(rules('mcp(s/t)'), { mcp: { server: 's', tool: 't' } })).not.toBeNull()
    expect(deniedBy(rules('mcp(s/t)'), { mcp: { server: 's', tool: 'u' } })).toBeNull()
    expect(deniedBy(rules('mcp(*)'), { mcp: { server: 'x', tool: 'y' } })).not.toBeNull()
    expect(parseRule('mcp(nos)')).toBeNull()
  })

  it('match a domain and its subdomains', () => {
    expect(deniedBy(rules('read_url(example.com)'), { readUrls: ['https://www.example.com/a'] })).not.toBeNull()
    expect(deniedBy(rules('read_url(example.com)'), { readUrls: ['https://notexample.com/'] })).toBeNull()
    expect(deniedBy(rules('read_url(example.com)'), { executeUrls: ['https://example.com/'] })).toBeNull()
    expect(deniedBy(rules('execute_url(example.com)'), { executeUrls: ['https://example.com/'] })).not.toBeNull()
  })
})
