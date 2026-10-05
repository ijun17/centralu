import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults, type AgentVersions, type SessionInfo } from '@cc/protocol'
import { AgentVersionService, restartDecision, type VersionSessions } from './agent-versions.js'
import type { SessionIdle } from './idle.js'

/**
 * Moving sessions to a newly installed agent CLI (#297): the decision as data, and the service's timing with the
 * session manager faked — the restart itself, including under the keeper, is in sessions/agent-versions-restart.test.ts.
 */

const IDLE: SessionIdle = { idle: true }

describe('whether to restart a session on the installed CLI (#297)', () => {
  const base = { session: { live: true, agentVersion: '2.1.282' }, installed: '2.1.290', idle: IDLE, quietFor: 60_000, quietMs: 60_000 }

  it('restarts a live, idle, quiet session that runs an older CLI', () => {
    expect(restartDecision(base)).toEqual({ restart: true })
  })

  it('leaves a session alone while it holds anything the restart would lose', () => {
    for (const reason of ['turn', 'approval', 'question', 'background', 'background_unknown'] as const) {
      expect(restartDecision({ ...base, idle: { idle: false, reason } })).toEqual({ restart: false, why: reason })
    }
  })

  it('waits out the quiet period after the session last said anything', () => {
    expect(restartDecision({ ...base, quietFor: 59_999 })).toEqual({ restart: false, why: 'recent' })
  })

  it('does not restart a session already on the installed version, one whose version is unknown, or one with no process', () => {
    expect(restartDecision({ ...base, installed: '2.1.282' })).toEqual({ restart: false, why: 'current' })
    expect(restartDecision({ ...base, session: { live: true, agentVersion: null } })).toEqual({ restart: false, why: 'current' })
    expect(restartDecision({ ...base, installed: null })).toEqual({ restart: false, why: 'current' })
    expect(restartDecision({ ...base, session: { live: false, agentVersion: '2.1.282' } })).toEqual({ restart: false, why: 'not_live' })
  })
})

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: 'ext', name: id, autoNamed: false, state: 'waiting_input',
    lastReadSeq: 0, lastSeq: 0, createdAt: 0, waitingSince: null, live: true, model: null, effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, scopeSessionIds: null, roleAppend: null,
    appId: null, parentSessionId: null, ...sessionLiveDefaults(), agentVersion: '2.1.282', ...over,
  }
}

class FakeSessions implements VersionSessions {
  sessions = new Map<string, SessionInfo>()
  idle = new Map<string, SessionIdle>()
  restarted: string[] = []
  moved: [string, string, string][] = []
  listSessions() {
    return [...this.sessions.values()]
  }
  sessionIdle(id: string) {
    return this.idle.get(id) ?? IDLE
  }
  async restartSession(id: string) {
    this.restarted.push(id)
    const s = this.sessions.get(id)!
    // The new process reports the version it runs
    s.agentVersion = '2.1.290'
    return { resumed: true }
  }
  noteAgentMoved(id: string, from: string, to: string) {
    this.moved.push([id, from, to])
  }
}

describe('the agent version service (#297)', () => {
  let now = 1_000_000
  let installed: string | null = '2.1.290'
  let sessions: FakeSessions
  let published: AgentVersions[]
  let checks: { tool: string; from: string; to: string }[]
  let seen: Record<string, string>
  let autoApply = true

  const make = () =>
    new AgentVersionService({
      tools: () => [{ tool: 'claude', installedVersion: async () => installed }],
      sessions,
      publish: (s) => published.push(s),
      readAutoApply: () => autoApply,
      writeAutoApply: (v) => (autoApply = v),
      readSeen: () => seen,
      writeSeen: (v) => (seen = v),
      capabilityCheck: (c) => checks.push(c),
      now: () => now,
      quietMs: 60_000,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    now = 1_000_000
    installed = '2.1.290'
    autoApply = true
    sessions = new FakeSessions()
    published = []
    checks = []
    seen = {}
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = async (ms: number) => {
    now += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('reads the installed versions and publishes them, with moving idle sessions on by default', async () => {
    const svc = make()
    const s = await svc.check(true)
    expect(s).toEqual({ installed: { claude: '2.1.290' }, autoApply: true, checkedAt: now })
    expect(published.at(-1)).toEqual(s)
    expect(svc.installedNow('claude')).toBe('2.1.290')
  })

  it('restarts an idle session on the new CLI by itself once it has been quiet, and says so in the conversation', async () => {
    sessions.sessions.set('a', session('a'))
    const svc = make()
    svc.observe({ type: 'turn_complete', sessionId: 'a' })
    await svc.check(true)
    await advance(59_000)
    expect(sessions.restarted).toEqual([])
    await advance(1_000)
    expect(sessions.restarted).toEqual(['a'])
    expect(sessions.moved).toEqual([['a', '2.1.282', '2.1.290']])
  })

  it('never restarts a session that is working, waiting on the person or running background work', async () => {
    sessions.sessions.set('a', session('a'))
    sessions.idle.set('a', { idle: false, reason: 'background' })
    const svc = make()
    await svc.check(true)
    await advance(120_000)
    expect(sessions.restarted).toEqual([])
    // It finishes: the next event schedules a look, and after the quiet period it moves
    sessions.idle.set('a', IDLE)
    svc.observe({ type: 'background_tasks', sessionId: 'a', live: [] })
    await advance(60_000)
    expect(sessions.restarted).toEqual(['a'])
  })

  it('an event from the session pushes the restart back: a person typing the next message is not cut off', async () => {
    sessions.sessions.set('a', session('a'))
    const svc = make()
    await svc.check(true)
    await advance(50_000)
    svc.observe({ type: 'user_message', sessionId: 'a', seq: 2, text: 'next' })
    await advance(50_000)
    expect(sessions.restarted).toEqual([])
    await advance(10_000)
    expect(sessions.restarted).toEqual(['a'])
  })

  it('with the setting off, nothing restarts by itself, but the header’s action still restarts the idle ones', async () => {
    autoApply = false
    sessions.sessions.set('a', session('a'))
    sessions.sessions.set('b', session('b'))
    sessions.idle.set('b', { idle: false, reason: 'turn' })
    sessions.sessions.set('c', session('c', { agentVersion: '2.1.290' }))
    const svc = make()
    await svc.check(true)
    await advance(300_000)
    expect(sessions.restarted).toEqual([])
    expect(await svc.applyNow()).toEqual({ restarted: ['a'], busy: ['b'] })
    expect(sessions.restarted).toEqual(['a'])
  })

  it('turning the setting off stops a restart that was already scheduled', async () => {
    sessions.sessions.set('a', session('a'))
    const svc = make()
    await svc.check(true)
    svc.setAutoApply(false)
    expect(autoApply).toBe(false)
    await advance(120_000)
    expect(sessions.restarted).toEqual([])
  })

  it('runs the capability check seam once when an installed CLI changes version, also across a host restart (#270)', async () => {
    seen = { claude: '2.1.282' }
    const svc = make()
    await svc.check(true)
    expect(checks).toEqual([{ tool: 'claude', from: '2.1.282', to: '2.1.290' }])
    expect(seen).toEqual({ claude: '2.1.290' })
    await svc.check(true)
    expect(checks).toHaveLength(1)
  })

  it('a focus soon after a reading answers with it; a process reporting a newer CLI than the reading reads again', async () => {
    installed = '2.1.282'
    sessions.sessions.set('a', session('a'))
    const svc = make()
    await svc.check(true)
    installed = '2.1.290'
    expect((await svc.check(false)).installed.claude).toBe('2.1.282')
    svc.observe({ type: 'agent_version', sessionId: 'a', version: '2.1.290' })
    await vi.advanceTimersByTimeAsync(0)
    expect(svc.current().installed.claude).toBe('2.1.290')
  })
})
