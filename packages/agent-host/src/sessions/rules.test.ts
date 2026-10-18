import { describe, expect, it } from 'vitest'
import { NO_PATH, type ApprovalDetail } from '@cc/protocol'
import type { AgentAdapter, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/**
 * C-2: does an "always allow" rule survive a restart.
 * In M1, the matcher was saved as an empty string and effectively had no effect — this guards
 * against that regression.
 */

type Fake = { applied: string[][]; given: (string | undefined)[]; emits: Map<string, EventSink> }

function fakeAdapter(f: Fake): AgentAdapter {
  return {
    tool: 'claude',
    descriptor: { name: 'claude', label: 'Claude Code', mark: 'C', install: 'npm i -g x', login: 'x login' },
    capabilities: { approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false },
    detect: async () => ({ tool: 'claude', installed: true, loggedIn: true, detail: 'fake' }),
    createSession: async (opts, emit): Promise<SessionHandle> => {
      f.emits.set(opts.sessionId, emit)
      return {
        sessionId: opts.sessionId,
        externalId: `ext-${opts.sessionId}`,
        send: () => {},
        respondApproval: (_id, _decision, _scope, matcher) => (f.given.push(matcher), true),
        applyRules: (m) => void f.applied.push([...m]),
        interrupt: () => {},
        dispose: async () => {},
      }
    },
  }
}

const fake = (): Fake => ({ applied: [], given: [], emits: new Map() })

async function setup() {
  const store = new Store()
  const f = fake()
  const mgr = new SessionManager(store, new Map([['claude', fakeAdapter(f)]]), () => {})
  const project = await mgr.addProject(process.cwd())
  const session = await mgr.createSession({
    projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
  })
  /** The session's agent asks: the card the person answers */
  const ask = (requestId: string, detail: ApprovalDetail) => f.emits.get(session.id)!({ type: 'approval_request', sessionId: session.id, requestId, detail })
  const command = (c: string, extra: Partial<Extract<ApprovalDetail, { kind: 'command' }>> = {}): ApprovalDetail => ({ kind: 'command', command: c, cwd: project.path, ...extra })
  return { store, mgr, f, project, session, ask, command }
}

describe('approval rules persist (C-2)', () => {
  it('saves the rule when given always + the card’s own key', async () => {
    const { mgr, session, ask, command } = await setup()
    ask('req-1', command('npm test'))
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'npm test')
    // id and createdAt are used by the settings screen to show when a rule was created, for deleting it (E-4)
    expect(mgr.listApprovalRules()).toMatchObject([{ scope: 'session', matcher: 'npm test', decision: 'allow' }])
    expect(mgr.listApprovalRules()[0]!.id).toBeGreaterThan(0)
    // Carries which session the rule belongs to — the settings screen labels each row with its owner (#183)
    expect(mgr.listApprovalRules()[0]).toMatchObject({ sessionId: session.id, projectId: null })
  })

  it('does not save it with no matcher (an empty rule is useless)', async () => {
    const { mgr, session, ask, command } = await setup()
    ask('req-1', command('npm test'))
    mgr.respondApproval(session.id, 'req-1', 'always', 'session')
    expect(mgr.listApprovalRules()).toEqual([])
  })

  // An edit with no path has no key to match (#428): a rule saved for "(no path)" would be listed and never apply
  it('does not save a rule for a file edit with no path', async () => {
    const { mgr, session, ask } = await setup()
    ask('req-1', { kind: 'file_edit', path: NO_PATH, diffPreview: '', multi: false })
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', NO_PATH)
    expect(mgr.listApprovalRules()).toEqual([])
  })

  /*
   * What is remembered is the host's key for the card, not what the window sent (#838 review): a window from before
   * #838, during a swap, sends a command ending in `*` or a flagged command as its matcher.
   */
  it('remembers nothing the card’s key is not: a wider matcher, another command, a flagged command, one ending in *', async () => {
    const { mgr, session, ask, command, f } = await setup()
    const cases: [ApprovalDetail, string][] = [
      [command('npm test'), 'npm test*'],
      [command('npm test'), 'rm -rf /'],
      // No key at all since #908: a window from before it sends the command as the matcher
      [command('npm test', { unsandboxed: true }), 'npm test'],
      [command('cat logs/*'), 'cat logs/*'],
    ]
    for (const [i, [detail, matcher]] of cases.entries()) {
      ask(`req-${i}`, detail)
      mgr.respondApproval(session.id, `req-${i}`, 'always', 'project', matcher)
    }
    // An answer whose request id is not the card standing
    ask('req-x', command('ls'))
    mgr.respondApproval(session.id, 'req-other', 'always', 'project', 'ls')
    expect(mgr.listApprovalRules()).toEqual([])
    // The call itself is allowed, and the adapter is given no matcher to keep
    expect(f.given).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('a session-scoped rule is injected only into that session', async () => {
    const { store, mgr, session, project, ask, command } = await setup()
    ask('req-1', command('ls'))
    mgr.respondApproval(session.id, 'req-1', 'always', 'session', 'ls')

    // Simulates a host restart: a new manager is created on the same store
    const f2 = fake()
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(f2)]]), () => {})
    const res = await mgr2.resumeSession(session.id)
    expect(res.resumed).toBe(true)
    expect(f2.applied[0]).toContain('ls')

    // Does not leak into another session
    const other = await mgr2.createSession({
      projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
    })
    const otherRules = f2.applied[f2.applied.length - 1]
    expect(otherRules).not.toContain('ls')
    expect(other.id).not.toBe(session.id)
  })

  it('a project-scoped rule also applies to a new session in the same project', async () => {
    const { store, mgr, session, project, ask, command } = await setup()
    ask('req-1', command('git status'))
    mgr.respondApproval(session.id, 'req-1', 'always', 'project', 'git status')

    const f2 = fake()
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(f2)]]), () => {})
    await mgr2.createSession({
      projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal',
    })
    expect(f2.applied[0]).toContain('git status')
  })

  /*
   * A newer build may store a rule this one cannot read (#384): another decision, or another scope. A rule is a
   * permission, so one that cannot be read allows nothing; the rules this build can read still apply.
   */
  it('a rule with a decision or scope this build does not know allows nothing, and the others still apply', async () => {
    const { store, project } = await setup()
    store.permissions.addApprovalRule({ scope: 'project', projectId: project.id, matcher: 'git status', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: project.id, matcher: 'rm -rf build', decision: 'deny' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: project.id, matcher: 'npm publish', decision: 'ask' })
    store.permissions.addApprovalRule({ scope: 'machine', projectId: project.id, matcher: 'curl example.com', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'everywhere', matcher: 'make deploy', decision: 'allow' })

    const f2 = fake()
    const mgr2 = new SessionManager(store, new Map([['claude', fakeAdapter(f2)]]), () => {})
    await mgr2.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const outside = await mgr2.createSession({ projectId: null, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    expect(outside.projectId).toBeNull()
    expect(f2.applied[0]).toEqual(['git status'])
    expect(f2.applied[1]).toEqual([])
  })

  // A rule ending in * allows nothing since #838, and an older build reads it as a prefix: it goes at startup
  it('drops saved rules ending in * when the host starts, and keeps the rest', async () => {
    const store = new Store()
    store.permissions.addApprovalRule({ scope: 'project', projectId: 'p', matcher: 'npm test*', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: 'p', matcher: 'git status', decision: 'allow' })
    store.permissions.addApprovalRule({ scope: 'project', projectId: 'p', matcher: 'git * origin', decision: 'allow' })
    const mgr = new SessionManager(store, new Map([['claude', fakeAdapter(fake())]]), () => {})
    expect(mgr.listApprovalRules().map((r) => r.matcher).sort()).toEqual(['git * origin', 'git status'])
  })
})
