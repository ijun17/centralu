import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionLiveDefaults, type BackgroundTask } from '@cc/protocol'
import { eventually } from '../../../../tooling/test-timing.js'
import type { AskProjectResult, LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { scriptedAdapters } from '../links/scripted-agent.test-helpers.js'
import { PAUSED_REPORT_SETTLE_MS, SessionManager } from './manager.js'
import { askProjectText } from './tool-answers.js'

/**
 * ask_project to a project on a linked machine, when the session there ends its turn waiting on its own background
 * work (#1457): the call answers that the work is paused, with the words so far, and the asker is woken once with the
 * work's last turn end, as a local child's report is (#721, #723). The machine here is a stand-in that says what the
 * test says, over the real manager and its linked reports; links.test.ts runs the real machine.
 */

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }
const done = { ...verify, status: 'completed' as const }

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const c of cleanup.splice(0)) c()
})

/** A hub with a trusted project and its session `h1` (the asker), and a machine `m1` with one session `w1` in its project `api` */
async function hub(o: { tasks?: boolean } = {}) {
  const store = new Store()
  const path = mkdtempSync(join(tmpdir(), 'cc-ask-paused-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  store.projects.addProject({ id: 'p-hub', path, name: 'hub-project' })
  store.sessions.upsertSession({
    id: 'h1', projectId: 'p-hub', kind: 'worker', tool: 'claude', externalId: 'ext-h1', name: 'Asker', autoNamed: false,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null,
    serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null,
    roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
  const mgr = new SessionManager(store, scriptedAdapters(), () => {})
  await mgr.setProjectTrusted('p-hub', true)
  let words = 'started, running in the background'
  let state = 'idle'
  let linked = true
  let failSend = false
  const sent: string[] = []
  const project = { id: 'm1.p-api', name: 'api', path: '/api', defaultTool: null, machine: 'Box', machineId: 'm1', trusted: true }
  const reader = {
    machineOf: (id: string) => (id.startsWith('m1.') ? 'Box' : null),
    projects: async () => ({ projects: [project], away: [] }),
    projectSessions: async () => ({ ok: true as const, sessions: [{ id: 'm1.w1', name: 'Worker', state }] }),
    send: async (_id: string, text: string) => {
      if (failSend) return { ok: false as const, error: 'Box is not reachable right now' }
      sent.push(text)
      return { ok: true as const }
    },
    describe: () => ({ name: 'Worker', project: 'api on Box' }),
    lastWords: async () => ({ ok: true as const, text: words, length: words.length, seq: 1 }),
    machineLinked: () => linked,
    machineWaitsForPerson: () => false,
    // An older machine does not list its sessions' background tasks (`tasks` off): it is read as having none
    backgroundTasks: async () => (o.tasks === false ? null : []),
  } as unknown as LinkedSessions
  mgr.useLinkedReader(reader)
  cleanup.push(() => void mgr.disposeAll())

  const event = (e: Record<string, unknown>) => mgr.observeLinked({ sessionId: 'm1.w1', ...e } as never)
  const tasks = (live: BackgroundTask[], ended?: BackgroundTask[]) => event({ type: 'background_tasks', live, ...(ended ? { ended } : {}) })
  /** A turn of the machine's session: it works, and ends */
  const turn = () => {
    state = 'working'
    event({ type: 'message_delta' })
    state = 'idle'
    event({ type: 'turn_complete' })
    event({ type: 'state_change', state: 'waiting_input' })
  }
  /** What reached the asker as a report from Centralu */
  const reports = () => store.messages.loadMessages('h1', 50).map((m) => String((m.payload as { text?: string }).text ?? '')).filter((t) => t.startsWith('[Centralu]'))
  const settle = async (n: number) => {
    const t0 = Date.now()
    while (reports().length < n && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 50))
  }
  /** ask_project from `h1`, with the person's card allowed; resolves with the call's answer once `after` has run on the machine */
  const ask = async (task: string | undefined, after?: () => void): Promise<AskProjectResult> => {
    const before = sent.length
    const call = mgr.askProject('h1', { project: 'm1/api', ...(task ? { task } : {}) })
    if (task) {
      await eventually(() => !!mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval)
      mgr.respondApproval('h1', mgr.listSessions().find((s) => s.id === 'h1')!.pendingApproval!.requestId, 'allow')
      // The machine's events can only be about this task once it has gone in
      if (after) await eventually(() => sent.length > before)
    }
    after?.()
    return call
  }
  return {
    mgr, store, sent, reports, settle, ask, event, tasks, turn,
    says: (text: string) => (words = text),
    failNextSend: () => (failSend = true),
    dropLink: () => {
      linked = false
      mgr.observeLinked({ type: 'machine_status', machine: { id: 'm1', name: 'Box', status: 'disconnected' } })
    },
  }
}

describe('ask_project to a linked machine whose session ends its turn on its own background work (#1457)', () => {
  it('answers that it is paused, and wakes the asker once with the later turn of the work', async () => {
    const h = await hub()
    const r = await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'turn_complete' })
    })
    if (!r.ok || r.state !== 'done') throw new Error(JSON.stringify(r))
    expect(r.answer).toBe('started, running in the background')
    expect(r.paused).toContain('background work is still running there (pnpm verify)')
    expect(r.paused).toContain('read_session(sessionId="m1.w1")')
    const text = askProjectText(r).text
    expect(text).toContain('has not finished')
    expect(text).toContain('started, running in the background')
    // The call is the answer to this turn: nothing is sent to the asker for it
    await h.settle(0)
    expect(h.reports()).toEqual([])

    // The work ends, and the turn its ending starts writes the result
    h.says('8 pass / 2 fail')
    h.tasks([], [done])
    h.turn()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]).toMatch(/^\[Centralu\] The assigned work finished\./)
    expect(h.reports()[0]).toContain('8 pass / 2 fail')
    expect(h.reports()[0]).toContain('id: m1.w1')

    // Exactly once: a later turn there is not the assigned work
    h.turn()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
  })

  it('a turn that ends while the work still runs says nothing more, and the work ending with no turn after it settles the report', async () => {
    const h = await hub()
    const r = await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'turn_complete' })
    })
    expect(r).toMatchObject({ ok: true, state: 'done', paused: expect.any(String) })
    h.turn()
    await h.settle(0)
    expect(h.reports()).toEqual([])
    // No turn follows the work's end: after the settle wait it is reported as ended
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    h.tasks([], [done])
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 100)
    vi.useRealTimers()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]).toContain('background work ended (pnpm verify: completed) and no turn followed')
  })

  it('a call that went away before the turn ended still gets the pause when it collects, and the report is not told twice', async () => {
    const h = await hub()
    const stop = new AbortController()
    const call = h.mgr.askProject('h1', { project: 'm1/api', task: 'run the suite' }, stop.signal)
    await eventually(() => !!h.mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval)
    h.mgr.respondApproval('h1', h.mgr.listSessions().find((s) => s.id === 'h1')!.pendingApproval!.requestId, 'allow')
    await eventually(() => h.sent.length > 0)
    stop.abort()
    expect(await call).toMatchObject({ ok: false, error: expect.stringContaining('was left running') })
    // The turn ends on its background work with nobody waiting: the end is owed all the same
    h.event({ type: 'message_delta' })
    h.tasks([verify])
    h.event({ type: 'turn_complete' })
    const collected = await h.ask(undefined)
    expect(collected).toMatchObject({ ok: true, state: 'done', answer: 'started, running in the background', paused: expect.stringContaining('pnpm verify') })
    h.says('8 pass / 2 fail')
    h.tasks([], [done])
    h.turn()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]).toContain('8 pass / 2 fail')
  })

  it('collected after the report of the work went out, the words are the final ones, not a pause', async () => {
    const h = await hub()
    const stop = new AbortController()
    const call = h.mgr.askProject('h1', { project: 'm1/api', task: 'run the suite' }, stop.signal)
    await eventually(() => !!h.mgr.listSessions().find((s) => s.id === 'h1')?.pendingApproval)
    h.mgr.respondApproval('h1', h.mgr.listSessions().find((s) => s.id === 'h1')!.pendingApproval!.requestId, 'allow')
    await eventually(() => h.sent.length > 0)
    stop.abort()
    await call
    h.event({ type: 'message_delta' })
    h.tasks([verify])
    h.event({ type: 'turn_complete' })
    h.says('8 pass / 2 fail')
    h.tasks([], [done])
    h.turn()
    await h.settle(1)
    const collected = await h.ask(undefined)
    expect(collected).toMatchObject({ ok: true, state: 'done', answer: '8 pass / 2 fail' })
    expect((collected as { paused?: string }).paused).toBeUndefined()
  })

  it('a link lost while the work is paused tells the asker so, once', async () => {
    const h = await hub()
    await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'turn_complete' })
    })
    h.dropLink()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]).toContain('the link to Box dropped before that work ended')
    h.dropLink()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
  })

  it('a turn that ends with no such work answers as before, and no report follows', async () => {
    const h = await hub()
    const r = await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.event({ type: 'turn_complete' })
    })
    expect(r).toMatchObject({ ok: true, state: 'done', answer: 'started, running in the background' })
    expect((r as { paused?: string }).paused).toBeUndefined()
    expect(askProjectText(r).text).toContain('answered')
    h.turn()
    await h.settle(0)
    expect(h.reports()).toEqual([])
  })

  it('a machine that does not list its background tasks (an older build) answers as before, and no report follows', async () => {
    const h = await hub({ tasks: false })
    // It relays no `background_tasks` event either: the turn ends with nothing known of its work
    const r = await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.event({ type: 'turn_complete' })
    })
    expect(r).toMatchObject({ ok: true, state: 'done' })
    expect((r as { paused?: string }).paused).toBeUndefined()
    h.turn()
    await h.settle(0)
    expect(h.reports()).toEqual([])
  })

  it('a turn that failed is answered as it ended, with no report owed over the work', async () => {
    const h = await hub()
    const r = await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'error', error: { message: 'boom' } })
    })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('did not finish') })
    h.tasks([], [done])
    h.turn()
    await h.settle(0)
    expect(h.reports()).toEqual([])
  })

  it('a new task from the asker ends the pause: the second answer is the end, and the first report is not delivered besides', async () => {
    const h = await hub()
    await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'turn_complete' })
    })
    h.tasks([], [done])
    h.says('second answer')
    const second = await h.ask('and the lint', () => {
      h.event({ type: 'message_delta' })
      h.event({ type: 'turn_complete' })
    })
    expect(second).toMatchObject({ ok: true, state: 'done', answer: 'second answer' })
    await h.settle(0)
    expect(h.reports()).toEqual([])
  })

  it('a send that fails puts the pause back: the work still runs and its end is still owed', async () => {
    const h = await hub()
    await h.ask('run the suite', () => {
      h.event({ type: 'message_delta' })
      h.tasks([verify])
      h.event({ type: 'turn_complete' })
    })
    h.failNextSend()
    expect(await h.ask('and the lint')).toMatchObject({ ok: false, error: expect.stringContaining('Could not hand the task') })
    h.says('8 pass / 2 fail')
    h.tasks([], [done])
    h.turn()
    await h.settle(1)
    expect(h.reports()).toHaveLength(1)
    expect(h.reports()[0]).toContain('8 pass / 2 fail')
  })
})
