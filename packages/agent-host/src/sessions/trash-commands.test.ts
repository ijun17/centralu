import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ORCHESTRATOR_CHANGE, sessionLiveDefaults, type SessionInfo, type ToolName, type TrashedRun, type TrashedSession, type TrashedSubagentSteps } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { createRpcHandler } from '../rpc.js'
import { SessionManager } from './manager.js'
import { CrossAdapter } from './cross-project.test-helpers.js'
import { commandsFor, profileAllows, RARE_TIERS } from './orchestrator-tools.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The orchestrator's trash commands (#1219): listing, restoring and moving subagent steps to the trash act at once;
 * deleting for good, one item or all of it, waits for a card that names what goes, and never takes what the card did not
 * name. Each makes the window's own call (here the real RPC handler on a real store), so a session id is checked as the
 * window checks it.
 */
const COMMANDS = ['list_trash', 'restore_trashed', 'trash_subagent_steps', 'delete_trashed', 'empty_trash'] as const
type Command = (typeof COMMANDS)[number]

let root: string
let store: Store
let mgr: SessionManager
let rpc: (method: string, params: unknown) => Promise<unknown>
let projectId: string
let dir: string

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-trash-')))
  store = new Store()
  const adapters = new Map<ToolName, CrossAdapter>([['claude', new CrossAdapter('claude')]])
  const agents = adapters as unknown as Map<ToolName, AgentAdapter>
  mgr = new SessionManager(store, agents, () => {})
  const handler = createRpcHandler(mgr, agents)
  rpc = (method, params) => handler(method, params)
  mgr.useWindowRpc(rpc)
  dir = join(root, 'proj')
  mkdirSync(dir)
  const project = (await rpc('projects.add', { path: dir })) as { id: string }
  await rpc('projects.setTrusted', { projectId: project.id, trusted: true })
  projectId = project.id
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const newSession = async (name?: string) => {
  const s = (await rpc('agents.createSession', { projectId, cwd: dir, tool: 'claude' })) as SessionInfo
  if (name) await rpc('sessions.rename', { sessionId: s.id, name })
  return s
}
const trashed = async (name?: string) => {
  const s = await newSession(name)
  await rpc('agents.deleteSession', { sessionId: s.id })
  return s
}
const addSteps = (sessionId: string, n: number, parent = 'toolu_agent') => {
  for (let i = 1; i <= n; i++) {
    store.messages.appendSubagentMessage(sessionId, parent, {
      role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId, role: 'assistant', text: `step ${i}` }, ts: i,
    })
  }
}
const trash = async () => (await rpc('trash.list', {})) as { sessions: TrashedSession[]; runs: TrashedRun[]; subagentSteps: TrashedSubagentSteps[]; bytes: number }
const live = async () => ((await rpc('sessions.list', {})) as SessionInfo[]).map((s) => s.id)

/** A kept app run, as a deleted app-agent session leaves it (#378) */
async function keptRun() {
  store.sessions.upsertSession({
    id: 'a1', projectId, kind: 'worker', tool: 'claude', externalId: null, name: 'Notes · agent 10:00', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'safe', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: 'notes', ...sessionLiveDefaults(),
  })
  store.appRuns.beginAppRun({
    id: 'run1', projectId, appId: 'notes', kind: 'broker', tool: 'run_agent', callerKind: 'session', callerSessionId: null,
    parentRunId: null, status: 'running', durationMs: null, argsDigest: 'd', argsSummary: 'x', error: null, createdAt: 1, sessionId: 'a1',
  })
  store.appRuns.endAppRun('run1', { status: 'ok', durationMs: 5, error: null, agent: { request: 'Research it.', answer: 'Done.', output: null } })
  store.messages.appendMessages([{ sessionId: 'a1', seq: 1, role: 'user', kind: 'text', payload: { text: 'Research it.' }, ts: 1 }])
  store.keptRuns.keepRun({ runId: 'run1', sessionId: 'a1', sessionName: 'Notes · agent 10:00', appName: 'Notes', projectName: 'proj', tool: 'claude', keptAt: 9 })
  await store.trash.trashSession('a1', { projectId, projectName: 'proj', projectPath: dir, removeExternal: false, removeWorktree: false })
  await store.trash.purgeSession('a1')
}

/** The trash card standing in a session, if one is */
function card(sessionId: string) {
  const pending = mgr.listSessions().find((s) => s.id === sessionId)?.pendingApproval
  const d = pending?.detail
  return d?.kind === 'other' && d.about === ORCHESTRATOR_CHANGE ? { requestId: pending!.requestId, text: d.raw } : undefined
}

function run(orcId: string, command: Command, args: Record<string, unknown> = {}) {
  return mgr.runOrchestratorTool(orcId, 'centralu_run', { command, args })
}

/** Runs a command whose card the person answers with `decision`; the card's question and the answer */
async function answered(orcId: string, command: Command, args: Record<string, unknown>, decision: 'allow' | 'deny' | 'always', whileStanding?: () => Promise<void>) {
  const call = run(orcId, command, args)
  await eventually(() => !!card(orcId))
  const question = card(orcId)!.text
  await whileStanding?.()
  mgr.respondApproval(orcId, card(orcId)!.requestId, decision)
  return { question, r: await call }
}

describe('list_trash', () => {
  it('says the trash is empty', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'list_trash')
    expect(r.text).toBe('The trash: 0 sessions, 0 app runs, subagent steps of 0 sessions; 0 B in all.\nThe trash is empty.')
  })

  it('lists a trashed session with its project, size and what deleting for good takes, the steps in the trash and the sessions holding steps', async () => {
    const gone = await trashed('Old "plan"')
    const other = await newSession('Busy one')
    addSteps(other.id, 3)
    const moved = await newSession('Steps away')
    addSteps(moved.id, 2)
    await rpc('subagents.trash', { sessionId: moved.id })
    await keptRun()
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'list_trash')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('The trash: 1 session, 1 app run, subagent steps of 1 session;')
    expect(r.text).toMatch(new RegExp(`- "Old \\\\"plan\\\\"" \\[${gone.id}\\]: project "proj"; deleted \\d{4}-\\d\\d-\\d\\d; 0 messages, `))
    expect(r.text).toContain('Kept app runs (only empty_trash deletes these):')
    expect(r.text).toContain('- "Notes · agent 10:00" of the app "Notes"')
    expect(r.text).toMatch(new RegExp(`- "Steps away" \\[${moved.id}\\]: 2 steps in 1 run, `))
    // A session holding steps, not in the trash yet
    expect(r.text).toMatch(new RegExp(`Sessions holding subagent steps that trash_subagent_steps can move to the trash:\\n- "Busy one" \\[${other.id}\\]: 3 steps in 1 run`))
  })
})

describe('restore_trashed and trash_subagent_steps', () => {
  it('bring a session back, and move a session\'s subagent steps to the trash and back, with no card', async () => {
    const gone = await trashed('Came back')
    const busy = await newSession('Busy')
    addSteps(busy.id, 4)
    const orc = await mgr.orchestrator()

    const back = await run(orc.id, 'restore_trashed', { sessionId: gone.id })
    expect(back.isError).toBeFalsy()
    expect(back.text).toBe(`Restored "Came back" [${gone.id}] from the trash.`)
    expect(await live()).toContain(gone.id)
    expect((await trash()).sessions).toEqual([])

    const moved = await run(orc.id, 'trash_subagent_steps', { sessionId: busy.id })
    expect(moved.text).toMatch(/^Moved 4 subagent steps \(.+\) of .+ to the trash\. Its conversation and launch cards stay/)
    expect((await trash()).subagentSteps.map((t) => t.sessionId)).toEqual([busy.id])

    const restored = await run(orc.id, 'restore_trashed', { sessionId: busy.id, what: 'steps' })
    expect(restored.text).toContain('back under their launch cards')
    expect((await trash()).subagentSteps).toEqual([])
    expect(card(orc.id)).toBeUndefined()
  })

  it('says so when a session holds no steps to move, and refuses a session that is not in the trash, as the window does', async () => {
    const live1 = await newSession('Live')
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'trash_subagent_steps', { sessionId: live1.id })).text).toContain('holds no subagent steps to move')
    const notTrashed = await run(orc.id, 'restore_trashed', { sessionId: live1.id })
    expect(notTrashed.isError).toBe(true)
    await expect(rpc('trash.restore', { sessionId: live1.id })).rejects.toThrow()
    const badId = await run(orc.id, 'restore_trashed', { sessionId: 'not an id' })
    expect(badId.isError).toBe(true)
    expect(badId.text).toContain('Not a session id')
    await expect(rpc('trash.restore', { sessionId: 'not an id' })).rejects.toThrow(/Not a session id/)
  })
})

describe('restore_trashed of a session whose project was deleted', () => {
  async function trashedWithDeletedProject() {
    const other = join(root, 'other-proj')
    mkdirSync(other)
    const p = (await rpc('projects.add', { path: other })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: other, tool: 'claude' })) as SessionInfo
    await rpc('agents.deleteSession', { sessionId: s.id })
    await rpc('projects.delete', { projectId: p.id })
    return { s, other }
  }

  it('asks naming the folder that will be registered again, then restores it on Allow', async () => {
    const { s, other } = await trashedWithDeletedProject()
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'restore_trashed', { sessionId: s.id }, 'allow')
    expect(question).toContain('Its project')
    expect(question).toContain('was deleted, so restoring registers its folder')
    expect(question).toContain('other-proj')
    expect(r.text).toContain('from the trash.')
    expect(r.text).toContain('had been deleted; its folder is registered again')
    expect(await live()).toContain(s.id)
    expect(((await rpc('projects.list', {})) as { path: string }[]).map((x) => x.path)).toContain(other)
  })

  it('restores nothing and registers no folder when the person denies it', async () => {
    const { s } = await trashedWithDeletedProject()
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'restore_trashed', { sessionId: s.id }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve it, so nothing was restored/)
    expect((await trash()).sessions.map((x) => x.id)).toEqual([s.id])
    expect(await live()).not.toContain(s.id)
  })

  it('asks nothing for a session whose project is still there, and refuses one that is not in the trash', async () => {
    const orc = await mgr.orchestrator()
    const gone = await trashed('Plain')
    expect((await run(orc.id, 'restore_trashed', { sessionId: gone.id })).isError).toBeFalsy()
    expect(card(orc.id)).toBeUndefined()
    const none = await run(orc.id, 'restore_trashed', { sessionId: gone.id })
    expect(none.isError).toBe(true)
    expect(none.text).toMatch(/is not in the trash; list_trash shows what is\. Nothing was restored/)
  })
})

describe('delete_trashed', () => {
  it('asks naming the session, what it holds and that it cannot be undone, then deletes it for good on Allow', async () => {
    const gone = await trashed('Old plan')
    const keep = await trashed('Other')
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'delete_trashed', { sessionId: gone.id }, 'allow')
    expect(question).toContain('Delete the trashed session "Old plan" for good?')
    expect(question).toContain('0 messages')
    expect(question).toContain('attachments and handoff note leave this computer')
    expect(question).toContain('This cannot be undone.')
    expect(r.text).toBe(`Deleted "Old plan" [${gone.id}] for good.`)
    expect((await trash()).sessions.map((s) => s.id)).toEqual([keep.id])
  })

  it('deletes nothing when the person denies it, under every preset, and "always" remembers nothing', async () => {
    const a = await trashed('A')
    const b = await trashed('B')
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
    const denied = await answered(orc.id, 'delete_trashed', { sessionId: a.id }, 'deny')
    expect(denied.r.isError).toBe(true)
    expect(denied.r.text).toMatch(/did not approve it, so nothing was deleted/)
    expect((await trash()).sessions.length).toBe(2)
    await answered(orc.id, 'delete_trashed', { sessionId: a.id }, 'always')
    // The next one asks again
    const second = await answered(orc.id, 'delete_trashed', { sessionId: b.id }, 'deny')
    expect(second.r.isError).toBe(true)
    expect((await trash()).sessions.map((s) => s.id)).toEqual([b.id])
  })

  it('refuses a live session, or one that is not there, before any card: only the trash can be deleted from', async () => {
    const liveOne = await newSession('Live')
    const orc = await mgr.orchestrator()
    const live1 = await run(orc.id, 'delete_trashed', { sessionId: liveOne.id })
    expect(live1.isError).toBe(true)
    expect(live1.text).toMatch(/is not in the trash .* Nothing was deleted/)
    const none = await run(orc.id, 'delete_trashed', { sessionId: 'nothing-like-an-id' })
    expect(none.isError).toBe(true)
    expect(card(orc.id)).toBeUndefined()
    expect(await live()).toContain(liveOne.id)
  })

  it('does not delete a session the person restored while the card stood', async () => {
    const gone = await trashed('Changed my mind')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_trashed', { sessionId: gone.id }, 'allow', async () => {
      await rpc('trash.restore', { sessionId: gone.id })
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/is no longer in the trash \(restored or deleted while the card stood\), so nothing was deleted/)
    expect(await live()).toContain(gone.id)
  })

  it('does not delete a session that was restored and trashed again while the card stood: it is not what the card named', async () => {
    const gone = await trashed('Round trip')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_trashed', { sessionId: gone.id }, 'allow', async () => {
      await rpc('trash.restore', { sessionId: gone.id })
      // A later moment, so the second deletion is stamped later than the first
      await new Promise((resolve) => setTimeout(resolve, 5))
      await rpc('agents.deleteSession', { sessionId: gone.id })
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/was restored and deleted again while the card stood, so it is not what the card named and nothing was deleted/)
    expect((await trash()).sessions.map((x) => x.id)).toEqual([gone.id])
  })

  it('deletes the trashed subagent steps the card named, and keeps those moved to the trash after it', async () => {
    const s = await newSession('Stepped')
    addSteps(s.id, 2)
    await rpc('subagents.trash', { sessionId: s.id })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'delete_trashed', { sessionId: s.id, what: 'steps' }, 'allow', async () => {
      addSteps(s.id, 1, 'toolu_later')
      await rpc('subagents.trash', { sessionId: s.id })
    })
    expect(question).toContain('Delete the trashed subagent steps of "Stepped" for good? 2 steps in 1 run')
    expect(question).toContain('The session, its conversation and the steps not in the trash stay.')
    expect(r.text).toBe('Deleted the trashed subagent steps of "Stepped" for good.')
    // The step moved after the card was raised is still in the trash
    expect((await trash()).subagentSteps.map((t) => [t.sessionId, t.steps])).toEqual([[s.id, 1]])
    expect(await live()).toContain(s.id)
  })

  it('refuses steps that are not in the trash, before any card', async () => {
    const s = await newSession('No steps')
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'delete_trashed', { sessionId: s.id, what: 'steps' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/has no subagent steps in the trash/)
    expect(card(orc.id)).toBeUndefined()
  })
})

describe('empty_trash', () => {
  it('asks naming the counts, the size and some names, then deletes the sessions, the kept runs and the trashed steps', async () => {
    await trashed('First')
    await trashed('Second')
    const stepped = await newSession('Stepped')
    addSteps(stepped.id, 2)
    await rpc('subagents.trash', { sessionId: stepped.id })
    await keptRun()
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'empty_trash', {}, 'allow')
    expect(question).toContain('Empty the trash: delete 2 sessions, 1 kept app run and the trashed subagent steps of 1 session for good')
    expect(question).toContain('Sessions: "Second", "First"')
    expect(question).toContain('What reaches the trash after this card is not deleted. This cannot be undone.')
    expect(r.text).toBe('Deleted for good: 2 sessions, 1 app run, the subagent steps of 1 session.')
    const t = await trash()
    expect([t.sessions, t.runs, t.subagentSteps]).toEqual([[], [], []])
    // The session whose steps were deleted is still there
    expect(await live()).toContain(stepped.id)
  })

  it('names how many sessions it leaves out of the list, and what goes with them', async () => {
    for (let i = 1; i <= 12; i++) await trashed(`Session ${i}`)
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'empty_trash', {}, 'deny')
    expect(question).toContain('delete 12 sessions')
    expect(question).toContain('and 2 more sessions')
    expect(question).toContain('"Session 3"')
    expect(question).not.toContain('"Session 2"')
  })

  it('deletes nothing when the person denies it', async () => {
    await trashed('Keep me')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'empty_trash', {}, 'deny')
    expect(r.isError).toBe(true)
    expect((await trash()).sessions.length).toBe(1)
  })

  it('never deletes what the card did not name: a session restored meanwhile stays, one trashed meanwhile stays', async () => {
    const restored = await trashed('Restored meanwhile')
    await trashed('Goes')
    const orc = await mgr.orchestrator()
    let late = ''
    const { r } = await answered(orc.id, 'empty_trash', {}, 'allow', async () => {
      await rpc('trash.restore', { sessionId: restored.id })
      late = (await trashed('Late arrival')).id
    })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Deleted for good: 1 session.')
    expect(r.text).toContain('Not what the card named when it was answered (restored, deleted or deleted again meanwhile), so left alone: "Restored meanwhile".')
    expect(r.text).toContain('The trash now holds 1 session, 0 app runs and subagent steps of 0 sessions.')
    expect((await trash()).sessions.map((s) => s.id)).toEqual([late])
    expect(await live()).toContain(restored.id)
  })

  it('leaves a session alone that was restored and trashed again while the card stood', async () => {
    const again = await trashed('Again')
    await trashed('Plain')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'empty_trash', {}, 'allow', async () => {
      await rpc('trash.restore', { sessionId: again.id })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await rpc('agents.deleteSession', { sessionId: again.id })
    })
    expect(r.text).toContain('Deleted for good: 1 session.')
    expect(r.text).toContain('Not what the card named when it was answered (restored, deleted or deleted again meanwhile), so left alone: "Again".')
    expect((await trash()).sessions.map((x) => x.id)).toEqual([again.id])
  })

  it('asks nothing when the trash is already empty', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'empty_trash')
    expect(r.text).toBe('The trash is already empty.')
    expect(card(orc.id)).toBeUndefined()
  })

  it('shows a name that hides characters as escapes on the card', async () => {
    // A name no rename would write, as an older build or a tool's own title may have left it
    store.sessions.upsertSession({
      id: 'b1', projectId, kind: 'worker', tool: 'claude', externalId: null, name: `Plan${String.fromCharCode(0x202e)}gnp.txt`, autoNamed: false, state: 'idle',
      lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
      verbosity: null, serviceTier: null, permissionPreset: 'safe', importedFrom: null, worktree: null,
      parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    await store.trash.trashSession('b1', { projectId, projectName: 'proj', projectPath: dir, removeExternal: false, removeWorktree: false })
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'empty_trash', {}, 'deny')
    expect(question).toContain('"Plan' + String.fromCharCode(92) + 'u202egnp.txt"')
  })
})

describe('who may run them', () => {
  it('only the orchestrator, as rare commands in the default tier; no other seat in any tier', () => {
    for (const name of COMMANDS) {
      expect(commandsFor('orchestrator', 'commands')).toContain(name)
      for (const tier of RARE_TIERS) {
        for (const profile of ['scoped', 'builder', 'reader'] as const) {
          expect(profileAllows(profile, name, tier), `${profile} ${tier} ${name}`).toBe(false)
        }
      }
    }
  })

  it("refuses an ordinary session's calls by name and through centralu_run, and deletes nothing", async () => {
    const gone = await trashed('Safe in the trash')
    const caller = await newSession('Ordinary')
    for (const name of COMMANDS) {
      await expect(mgr.runOrchestratorTool(caller.id, name, { sessionId: gone.id }), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(caller.id, 'centralu_run', { command: name, args: { sessionId: gone.id } }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect((await trash()).sessions.map((s) => s.id)).toEqual([gone.id])
    expect(card(caller.id)).toBeUndefined()
  })
})
