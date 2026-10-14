import { describe, expect, it } from 'vitest'
import { CENTRALU_APPLY, CENTRALU_APPLY_QUESTION, isCentraluApply, type ApprovalDetail } from '@cc/protocol'
import { agentStartQuestion, answersInPlace, centraluUpdateQuestion, findMatchingRule, matchesRule, previewMatches, projectAccessQuestion, projectCreateQuestion, suggestMatcher } from './approval.js'

describe('the new-project question (#515)', () => {
  it('names the linked machine whose disk the path is on, and no machine for this computer (#82 phase 4)', () => {
    const d = { kind: 'project_create' as const, name: 'api', path: '/home/me/Centralu/api' }
    expect(projectCreateQuestion(d)).toBe('Make the empty folder /home/me/Centralu/api and add it as the project api?')
    expect(projectCreateQuestion({ ...d, machine: 'Ubuntu box' })).toBe('Make the empty folder /home/me/Centralu/api on Ubuntu box and add it as the project api?')
    expect(projectCreateQuestion({ ...d, machine: 'Ubuntu box', source: { git: 'https://x/api.git' } })).toBe(
      'Clone https://x/api.git into /home/me/Centralu/api on Ubuntu box and add it as the project api?',
    )
  })
})

describe('the start-agent question (#561)', () => {
  it('says which agent, where, with which permissions and on what', () => {
    const d = { kind: 'agent_start' as const, project: { id: 'p', name: 'website' }, tool: 'Codex', preset: 'safe' as const, text: 'write the parser' }
    expect(agentStartQuestion(d)).toBe('Start Codex in website, with safe permissions, to write the parser?')
    expect(agentStartQuestion({ ...d, model: 'gpt-6.1-sol' })).toBe('Start Codex (gpt-6.1-sol) in website, with safe permissions, to write the parser?')
    // In a new worktree (#561 part 2): the branch is part of what is agreed to
    expect(agentStartQuestion({ ...d, worktree: { branch: 'centralu/parser' } })).toBe(
      'Start Codex in website, in a new worktree on centralu/parser, with safe permissions, to write the parser?',
    )
  })
})

describe('the cross-project consent question (#371)', () => {
  const base = { kind: 'project_access' as const, from: { id: 'a', name: 'Consumer' }, to: { id: 'b', name: 'Toolkit' } }
  it('names the caller first and says what it would do in the other project', () => {
    expect(projectAccessQuestion({ ...base, access: 'delegate', session: { id: 's', name: 'Sprites' }, text: 'extract the assets' })).toBe('Let Consumer ask Toolkit / Sprites to extract the assets?')
    expect(projectAccessQuestion({ ...base, access: 'delegate', text: 'extract the assets' })).toBe('Let Consumer ask Toolkit to extract the assets?')
    expect(projectAccessQuestion({ ...base, access: 'apps', text: '', app: { appId: 'x', name: 'Extractor' } })).toBe(
      'Let Consumer use the app Extractor from Toolkit?',
    )
  })

  it('names a target the person has not trusted as such, and says nothing when it is trusted or not said (#382)', () => {
    const untrusted = { ...base, to: { ...base.to, trusted: false } }
    expect(projectAccessQuestion({ ...untrusted, access: 'delegate', text: 'extract the assets' })).toBe('Let Consumer ask Toolkit (not trusted) to extract the assets?')
    expect(projectAccessQuestion({ ...base, to: { ...base.to, trusted: true }, access: 'delegate', text: 'x' })).toBe('Let Consumer ask Toolkit to x?')
  })
})

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

  it('* spans line breaks, as the host prefix match does — a heredoc commit matches git commit*', () => {
    const heredoc = "git commit -m \"$(cat <<'EOF'\nfix: a thing\n\nbody\nEOF\n)\""
    expect(matchesRule(heredoc, 'git commit*')).toBe(true)
    expect(matchesRule('git commit -m "one\ntwo"', 'git commit*')).toBe(true)
    expect(previewMatches('git commit*', [heredoc])).toEqual([heredoc])
    // Still anchored: a line break does not let the prefix match somewhere in the middle
    expect(matchesRule('echo hi\ngit commit -m x', 'git commit*')).toBe(false)
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

describe('update cards (#581, #665)', () => {
  it('says what check and install ask', () => {
    expect(centraluUpdateQuestion({ kind: 'centralu_update', action: 'check' })).toBe('Allow this session to check for a Centralu update?')
    expect(centraluUpdateQuestion({ kind: 'centralu_update', action: 'install' })).toBe('Allow this session to install a Centralu update?')
  })

  // #665 review: "running agents keep going" alone hid what the host switch right after the relaunch stops
  it('says that applying relaunches the window and that the host switch after it stops long Centralu tool calls', () => {
    expect(CENTRALU_APPLY_QUESTION).toContain('running agents keep going')
    expect(CENTRALU_APPLY_QUESTION).toContain('switches the agent host')
    expect(CENTRALU_APPLY_QUESTION).toContain('after 10 seconds')
    expect(CENTRALU_APPLY_QUESTION).toContain('child agents')
    expect(isCentraluApply({ kind: 'other', raw: CENTRALU_APPLY_QUESTION, about: CENTRALU_APPLY })).toBe(true)
    expect(isCentraluApply({ kind: 'other', raw: 'a tool the adapter did not recognise' })).toBe(false)
  })
})

describe('answering from a list row (#543)', () => {
  it('a command and a single-file edit can be allowed or denied in place', () => {
    expect(answersInPlace({ kind: 'command', command: 'ls', cwd: '/p' })).toBe(true)
    expect(answersInPlace({ kind: 'file_edit', path: 'a.ts', diffPreview: '+x', multi: false })).toBe(true)
  })

  it('a card that offers more, or says more than one line, opens the session instead', () => {
    expect(answersInPlace({ kind: 'file_edit', path: 'a.ts, b.ts', diffPreview: '', multi: true })).toBe(false)
    expect(answersInPlace({ kind: 'agent_start', project: { id: 'p', name: 'w' }, tool: 'Codex', preset: 'safe', text: 'x' })).toBe(false)
    expect(answersInPlace({ kind: 'project_access', access: 'delegate', from: { id: 'a', name: 'A' }, to: { id: 'b', name: 'B' }, text: 'x' })).toBe(false)
    expect(answersInPlace({ kind: 'capability', app: { appId: 'app-x', projectId: null, name: 'X' }, capability: 'host:x', text: 'x' })).toBe(false)
    expect(answersInPlace({ kind: 'project_create', name: 'n', path: '/n' })).toBe(false)
    expect(answersInPlace({ kind: 'centralu_update', action: 'install' })).toBe(false)
    expect(answersInPlace({ kind: 'other', raw: '{}' })).toBe(false)
  })

  it('anything else pending in the session opens it too', () => {
    expect(answersInPlace({ kind: 'command', command: 'ls', cwd: '/p' }, 1)).toBe(false)
  })
})
