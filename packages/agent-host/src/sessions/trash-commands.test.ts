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
 * The orchestrator's session archive commands (#1219): listing, restoring and moving subagent steps to the session archive act at once;
 * deleting for good, one item or all of it, waits for a card that names what goes, and never takes what the card did not
 * name. Each makes the window's own call (here the real RPC handler on a real store), so a session id is checked as the
 * window checks it.
 */
const COMMANDS = ['list_archive', 'restore_archived', 'archive_subagent_steps', 'delete_session', 'delete_archived', 'delete_all_archived'] as const
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

/** The session archive card standing in a session, if one is */
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

describe('list_archive', () => {
  it('says the session archive is empty', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'list_archive')
    expect(r.text).toBe('The session archive: 0 sessions, 0 app runs, subagent steps of 0 sessions; 0 B in all.\nThe session archive is empty.')
  })

  it('lists an archived session with its project, size and what deleting for good takes, the steps in the session archive and the sessions holding steps', async () => {
    const gone = await trashed('Old "plan"')
    const other = await newSession('Busy one')
    addSteps(other.id, 3)
    const moved = await newSession('Steps away')
    addSteps(moved.id, 2)
    await rpc('subagents.trash', { sessionId: moved.id })
    await keptRun()
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'list_archive')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('The session archive: 1 session, 1 app run, subagent steps of 1 session;')
    expect(r.text).toMatch(new RegExp(`- "Old \\\\"plan\\\\"" \\[${gone.id}\\]: project "proj"; archived \\d{4}-\\d\\d-\\d\\d; 0 messages, `))
    expect(r.text).toContain('Kept app runs (only delete_all_archived deletes these):')
    expect(r.text).toContain('- "Notes · agent 10:00" of the app "Notes"')
    expect(r.text).toMatch(new RegExp(`- "Steps away" \\[${moved.id}\\]: 2 steps in 1 run, `))
    // A session holding steps, not in the session archive yet
    expect(r.text).toMatch(new RegExp(`Sessions holding subagent steps that archive_subagent_steps can move to the session archive:\\n- "Busy one" \\[${other.id}\\]: 3 steps in 1 run`))
  })
})

describe('restore_archived and archive_subagent_steps', () => {
  it('bring a session back, and move a session\'s subagent steps to the session archive and back, with no card', async () => {
    const gone = await trashed('Came back')
    const busy = await newSession('Busy')
    addSteps(busy.id, 4)
    const orc = await mgr.orchestrator()

    const back = await run(orc.id, 'restore_archived', { sessionId: gone.id })
    expect(back.isError).toBeFalsy()
    expect(back.text).toBe(`Restored "Came back" [${gone.id}] from the session archive.`)
    expect(await live()).toContain(gone.id)
    expect((await trash()).sessions).toEqual([])

    const moved = await run(orc.id, 'archive_subagent_steps', { sessionId: busy.id })
    expect(moved.text).toMatch(/^Moved 4 subagent steps \(.+\) of .+ to the session archive\. Its conversation and launch cards stay/)
    expect((await trash()).subagentSteps.map((t) => t.sessionId)).toEqual([busy.id])

    const restored = await run(orc.id, 'restore_archived', { sessionId: busy.id, what: 'steps' })
    expect(restored.text).toContain('back under their launch cards')
    expect((await trash()).subagentSteps).toEqual([])
    expect(card(orc.id)).toBeUndefined()
  })

  it('says so when a session holds no steps to move, and refuses a session that is not in the session archive, as the window does', async () => {
    const live1 = await newSession('Live')
    const orc = await mgr.orchestrator()
    expect((await run(orc.id, 'archive_subagent_steps', { sessionId: live1.id })).text).toContain('holds no subagent steps to move')
    const notTrashed = await run(orc.id, 'restore_archived', { sessionId: live1.id })
    expect(notTrashed.isError).toBe(true)
    await expect(rpc('trash.restore', { sessionId: live1.id })).rejects.toThrow()
    const badId = await run(orc.id, 'restore_archived', { sessionId: 'not an id' })
    expect(badId.isError).toBe(true)
    expect(badId.text).toContain('Not a session id')
    await expect(rpc('trash.restore', { sessionId: 'not an id' })).rejects.toThrow(/Not a session id/)
  })
})

describe('restore_archived of a session whose project was deleted', () => {
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
    const { question, r } = await answered(orc.id, 'restore_archived', { sessionId: s.id }, 'allow')
    expect(question).toContain('Its project')
    expect(question).toContain('was deleted, so restoring registers its folder')
    expect(question).toContain('other-proj')
    expect(r.text).toContain('from the session archive.')
    expect(r.text).toContain('had been deleted; its folder is registered again')
    expect(await live()).toContain(s.id)
    expect(((await rpc('projects.list', {})) as { path: string }[]).map((x) => x.path)).toContain(other)
  })

  it('restores nothing and registers no folder when the person denies it', async () => {
    const { s } = await trashedWithDeletedProject()
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'restore_archived', { sessionId: s.id }, 'deny')
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/did not approve it, so nothing was restored/)
    expect((await trash()).sessions.map((x) => x.id)).toEqual([s.id])
    expect(await live()).not.toContain(s.id)
  })

  it('asks nothing for a session whose project is still there, and refuses one that is not in the session archive', async () => {
    const orc = await mgr.orchestrator()
    const gone = await trashed('Plain')
    expect((await run(orc.id, 'restore_archived', { sessionId: gone.id })).isError).toBeFalsy()
    expect(card(orc.id)).toBeUndefined()
    const none = await run(orc.id, 'restore_archived', { sessionId: gone.id })
    expect(none.isError).toBe(true)
    expect(none.text).toMatch(/is not in the session archive; list_archive shows what is\. Nothing was restored/)
  })
})

describe('delete_session', () => {
  const listed = async () => ((await rpc('sessions.list', {})) as SessionInfo[]).map((s) => s.id)

  it("moves an idle session that nobody waits on with no card, keeping what the window's delete keeps, and restore_archived brings it back (#1512)", async () => {
    const orc = await mgr.orchestrator()
    const s = await newSession('Old work')
    const r = await run(orc.id, 'delete_session', { sessionId: s.id })
    expect(card(orc.id)).toBeUndefined()
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain(`Moved "Old work" [${s.id}] to the session archive.`)
    expect(r.text).toContain('restore_archived brings it back')
    expect(await listed()).not.toContain(s.id)
    const inTrash = (await trash()).sessions.find((x) => x.id === s.id)!
    // The two boxes of the window's delete stay unchecked: nothing goes for good with it
    expect(inTrash.conversationFile).not.toBe('remove')
    expect(inTrash.worktree?.remove ?? false).toBe(false)
    const back = await run(orc.id, 'restore_archived', { sessionId: s.id })
    expect(back.isError).toBeFalsy()
    expect(await listed()).toContain(s.id)
  })

  it('asks even when nothing is lost under the safe preset', async () => {
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'safe' })
    const s = await newSession('Idle one')
    const denied = await answered(orc.id, 'delete_session', { sessionId: s.id }, 'deny')
    expect(denied.question).toContain('Nothing else is lost: no one is waiting on it and it owes no report.')
    expect(denied.r.isError).toBe(true)
    expect(await listed()).toContain(s.id)
  })

  it('asks when moving the session drops something the session archive does not bring back, and moves nothing on Deny', async () => {
    const orc = await mgr.orchestrator()
    const s = await newSession('Old work')
    const caller = await newSession('Caller')
    const children = (mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    children.markReport(s.id, caller.id)
    const denied = await answered(orc.id, 'delete_session', { sessionId: s.id }, 'deny')
    expect(denied.question).toContain('Archive the session "Old work"?')
    expect(denied.question).toContain('The person started it themselves.')
    expect(denied.question).toContain("Restoring it from the session archive brings back its conversation, its worktree and the tool's own conversation file")
    expect(denied.question).toContain('Restoring does not bring back what the host lets go of when it leaves:')
    expect(denied.question).toContain('It is moved only if it is still at rest when you answer')
    expect(denied.r.isError).toBe(true)
    expect(await listed()).toContain(s.id)

    const { r } = await answered(orc.id, 'delete_session', { sessionId: s.id }, 'allow')
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('(not what the card listed as dropped)')
    expect(await listed()).not.toContain(s.id)
  })

  it('asks again under auto when it would drop something, and "always" is not offered', async () => {
    const orc = await mgr.orchestrator()
    await mgr.updateSettings(orc.id, { permissionPreset: 'auto' })
    const one = await newSession('One')
    const two = await newSession('Two')
    const caller = await newSession('Caller')
    const children = (mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    children.markReport(one.id, caller.id)
    children.markReport(two.id, caller.id)
    expect((await answered(orc.id, 'delete_session', { sessionId: one.id }, 'allow')).r.isError).toBeFalsy()
    const second = await answered(orc.id, 'delete_session', { sessionId: two.id }, 'deny')
    expect(second.r.isError).toBe(true)
    expect(await listed()).toContain(two.id)
  })

  it('names what the host lets go of that restoring does not bring back: a caller waiting for its report, reports its children owe it', async () => {
    const orc = await mgr.orchestrator()
    const waited = await newSession('Waited on')
    const other = await newSession('Caller')
    const owing = await newSession('Owing')
    const children = (mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    // `Caller` waits for the report of `Waited on`, which in turn is owed one by `Owing`
    children.markReport(waited.id, other.id)
    children.markReport(owing.id, waited.id)
    const { question, r } = await answered(orc.id, 'delete_session', { sessionId: waited.id }, 'deny')
    expect(question).toContain('Restoring does not bring back what the host lets go of when it leaves:')
    expect(question).toContain('- "Caller" is waiting for the report of the work it gave this session; that report will not come.')
    expect(question).toContain('- A session it started owes it a report; it will not be told, and the report is dropped.')
    expect(r.isError).toBe(true)
    expect(await listed()).toContain(waited.id)
  })

  it('decides at the last moment: a message the person sends while the card stands keeps the session, and its new turn is not cut', async () => {
    const orc = await mgr.orchestrator()
    const s = await newSession('Mine')
    const caller = await newSession('Caller')
    const children = (mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    children.markReport(s.id, caller.id)
    const { r } = await answered(orc.id, 'delete_session', { sessionId: s.id }, 'allow', async () => {
      await mgr.send(s.id, 'one more thing')
    })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('is not at rest any more')
    expect(await listed()).toContain(s.id)
    expect((await trash()).sessions).toEqual([])
    expect(mgr.listSessions().find((x) => x.id === s.id)?.state).toBe('working')
  })

  it('does not move a session whose losses changed while the card stood: it is not what the card named', async () => {
    const orc = await mgr.orchestrator()
    const s = await newSession('Changing')
    const first = await newSession('First caller')
    const caller = await newSession('Late caller')
    const children = (mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    children.markReport(s.id, first.id)
    const { r } = await answered(orc.id, 'delete_session', { sessionId: s.id }, 'allow', async () => void children.markReport(s.id, caller.id))
    expect(r.isError).toBe(true)
    expect(r.text).toContain('what moving it drops changed')
    expect(await listed()).toContain(s.id)
  })

  it('refuses before moving anything: itself, an id no session has, a bad id, and a session working or waiting on the person', async () => {
    const orc = await mgr.orchestrator()
    const own = await run(orc.id, 'delete_session', { sessionId: orc.id })
    expect(own.text).toBe('Nothing changed: This session cannot delete itself.')
    expect((await run(orc.id, 'delete_session', { sessionId: 's-nothing' })).text).toMatch(/No session \[s-nothing\] is listed/)
    expect((await run(orc.id, 'delete_session', { sessionId: '../x' })).isError).toBe(true)
    const busy = await newSession('Busy')
    await mgr.send(busy.id, 'work on it')
    await eventually(() => mgr.listSessions().find((s) => s.id === busy.id)?.state === 'working')
    const r = await run(orc.id, 'delete_session', { sessionId: busy.id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('"Busy" is busy (working); the person may be using it. Delete it once it is idle.')
    expect(await listed()).toContain(busy.id)
    expect((await trash()).sessions).toEqual([])
  })

  it('refuses a session with a background job still running, which the session archive would end for good, and takes it once only ended jobs are left', async () => {
    const orc = await mgr.orchestrator()
    const s = await newSession('Serving')
    const meta = (mgr as unknown as { meta: Map<string, { backgroundTasks: { id: string; kind: string; description: string; status: string }[] }> }).meta.get(s.id)!
    meta.backgroundTasks = [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'running' }]
    const r = await run(orc.id, 'delete_session', { sessionId: s.id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('"Serving" has 1 background job still running ("npm run dev"); deleting it would end it for good.')
    expect(await listed()).toContain(s.id)
    meta.backgroundTasks = [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'completed' }]
    expect((await run(orc.id, 'delete_session', { sessionId: s.id })).isError).toBeFalsy()
    expect(await listed()).not.toContain(s.id)
  })

  it('refuses a session that is not a worker, or whose machine cannot be reached', async () => {
    const orc = await mgr.orchestrator()
    const meta = (id: string) => (mgr as unknown as { meta: Map<string, { kind: string; unreachable?: boolean }> }).meta.get(id)!
    const lead = await newSession('Lead')
    meta(lead.id).kind = 'coordinator'
    const far = await newSession('Far')
    meta(far.id).unreachable = true
    const a = await run(orc.id, 'delete_session', { sessionId: lead.id })
    expect(a.text).toContain('"Lead" is a coordinator; only the person deletes those.')
    const b = await run(orc.id, 'delete_session', { sessionId: far.id })
    expect(b.text).toContain('"Far" is on a machine that cannot be reached just now')
    expect(await listed()).toEqual(expect.arrayContaining([lead.id, far.id]))
  })

  it("leaves the caller's own children to agent_session", async () => {
    const orc = await mgr.orchestrator()
    const child = await newSession('Child')
    // As start_agent leaves it: the orchestrator asked for it
    ;(mgr as unknown as { meta: Map<string, { askedBy?: string | null }> }).meta.get(child.id)!.askedBy = orc.id
    const r = await run(orc.id, 'delete_session', { sessionId: child.id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('is a child you started; delete it with agent_session (action delete)')
    expect(await listed()).toContain(child.id)
  })
})

describe('delete_archived', () => {
  it('asks naming the session, what it holds and that it cannot be undone, then deletes it for good on Allow', async () => {
    const gone = await trashed('Old plan')
    const keep = await trashed('Other')
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'delete_archived', { sessionId: gone.id }, 'allow')
    expect(question).toContain('Delete the archived session "Old plan" for good?')
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
    const denied = await answered(orc.id, 'delete_archived', { sessionId: a.id }, 'deny')
    expect(denied.r.isError).toBe(true)
    expect(denied.r.text).toMatch(/did not approve it, so nothing was deleted/)
    expect((await trash()).sessions.length).toBe(2)
    await answered(orc.id, 'delete_archived', { sessionId: a.id }, 'always')
    // The next one asks again
    const second = await answered(orc.id, 'delete_archived', { sessionId: b.id }, 'deny')
    expect(second.r.isError).toBe(true)
    expect((await trash()).sessions.map((s) => s.id)).toEqual([b.id])
  })

  it('refuses a live session, or one that is not there, before any card: only the session archive can be deleted from', async () => {
    const liveOne = await newSession('Live')
    const orc = await mgr.orchestrator()
    const live1 = await run(orc.id, 'delete_archived', { sessionId: liveOne.id })
    expect(live1.isError).toBe(true)
    expect(live1.text).toMatch(/is not in the session archive .* Nothing was deleted/)
    const none = await run(orc.id, 'delete_archived', { sessionId: 'nothing-like-an-id' })
    expect(none.isError).toBe(true)
    expect(card(orc.id)).toBeUndefined()
    expect(await live()).toContain(liveOne.id)
  })

  it('does not delete a session the person restored while the card stood', async () => {
    const gone = await trashed('Changed my mind')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_archived', { sessionId: gone.id }, 'allow', async () => {
      await rpc('trash.restore', { sessionId: gone.id })
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/is no longer in the session archive \(restored or deleted while the card stood\), so nothing was deleted/)
    expect(await live()).toContain(gone.id)
  })

  it('does not delete a session that was restored and trashed again while the card stood: it is not what the card named', async () => {
    const gone = await trashed('Round trip')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_archived', { sessionId: gone.id }, 'allow', async () => {
      await rpc('trash.restore', { sessionId: gone.id })
      // A later moment, so the second deletion is stamped later than the first
      await new Promise((resolve) => setTimeout(resolve, 5))
      await rpc('agents.deleteSession', { sessionId: gone.id })
    })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/was restored and deleted again while the card stood, so it is not what the card named and nothing was deleted/)
    expect((await trash()).sessions.map((x) => x.id)).toEqual([gone.id])
  })

  it('deletes the archived subagent steps the card named, and keeps those archived after it', async () => {
    const s = await newSession('Stepped')
    addSteps(s.id, 2)
    await rpc('subagents.trash', { sessionId: s.id })
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'delete_archived', { sessionId: s.id, what: 'steps' }, 'allow', async () => {
      addSteps(s.id, 1, 'toolu_later')
      await rpc('subagents.trash', { sessionId: s.id })
    })
    expect(question).toContain('Delete the archived subagent steps of "Stepped" for good? 2 steps in 1 run')
    expect(question).toContain('The session, its conversation and the steps not in the session archive stay.')
    expect(r.text).toBe('Deleted the archived subagent steps of "Stepped" for good.')
    // The step moved after the card was raised is still in the session archive
    expect((await trash()).subagentSteps.map((t) => [t.sessionId, t.steps])).toEqual([[s.id, 1]])
    expect(await live()).toContain(s.id)
  })

  it('refuses steps that are not in the session archive, before any card', async () => {
    const s = await newSession('No steps')
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'delete_archived', { sessionId: s.id, what: 'steps' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/has no subagent steps in the session archive/)
    expect(card(orc.id)).toBeUndefined()
  })
})

describe('delete_all_archived', () => {
  it('asks naming the counts, the size and some names, then deletes the sessions, the kept runs and the archived steps', async () => {
    await trashed('First')
    await trashed('Second')
    const stepped = await newSession('Stepped')
    addSteps(stepped.id, 2)
    await rpc('subagents.trash', { sessionId: stepped.id })
    await keptRun()
    const orc = await mgr.orchestrator()
    const { question, r } = await answered(orc.id, 'delete_all_archived', {}, 'allow')
    expect(question).toContain('Delete everything in the session archive: delete 2 sessions, 1 kept app run and the archived subagent steps of 1 session for good')
    expect(question).toContain('Sessions: "Second", "First"')
    expect(question).toContain('What reaches the session archive after this card is not deleted. This cannot be undone.')
    expect(r.text).toBe('Deleted for good: 2 sessions, 1 app run, the subagent steps of 1 session.')
    const t = await trash()
    expect([t.sessions, t.runs, t.subagentSteps]).toEqual([[], [], []])
    // The session whose steps were deleted is still there
    expect(await live()).toContain(stepped.id)
  })

  it('names how many sessions it leaves out of the list, and what goes with them', async () => {
    for (let i = 1; i <= 12; i++) await trashed(`Session ${i}`)
    const orc = await mgr.orchestrator()
    const { question } = await answered(orc.id, 'delete_all_archived', {}, 'deny')
    expect(question).toContain('delete 12 sessions')
    expect(question).toContain('and 2 more sessions')
    expect(question).toContain('"Session 3"')
    expect(question).not.toContain('"Session 2"')
  })

  it('deletes nothing when the person denies it', async () => {
    await trashed('Keep me')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_all_archived', {}, 'deny')
    expect(r.isError).toBe(true)
    expect((await trash()).sessions.length).toBe(1)
  })

  it('never deletes what the card did not name: a session restored meanwhile stays, one trashed meanwhile stays', async () => {
    const restored = await trashed('Restored meanwhile')
    await trashed('Goes')
    const orc = await mgr.orchestrator()
    let late = ''
    const { r } = await answered(orc.id, 'delete_all_archived', {}, 'allow', async () => {
      await rpc('trash.restore', { sessionId: restored.id })
      late = (await trashed('Late arrival')).id
    })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('Deleted for good: 1 session.')
    expect(r.text).toContain('Not what the card named when it was answered (restored, deleted or deleted again meanwhile), so left alone: "Restored meanwhile".')
    expect(r.text).toContain('The session archive now holds 1 session, 0 app runs and subagent steps of 0 sessions.')
    expect((await trash()).sessions.map((s) => s.id)).toEqual([late])
    expect(await live()).toContain(restored.id)
  })

  it('leaves a session alone that was restored and trashed again while the card stood', async () => {
    const again = await trashed('Again')
    await trashed('Plain')
    const orc = await mgr.orchestrator()
    const { r } = await answered(orc.id, 'delete_all_archived', {}, 'allow', async () => {
      await rpc('trash.restore', { sessionId: again.id })
      await new Promise((resolve) => setTimeout(resolve, 5))
      await rpc('agents.deleteSession', { sessionId: again.id })
    })
    expect(r.text).toContain('Deleted for good: 1 session.')
    expect(r.text).toContain('Not what the card named when it was answered (restored, deleted or deleted again meanwhile), so left alone: "Again".')
    expect((await trash()).sessions.map((x) => x.id)).toEqual([again.id])
  })

  it('asks nothing when the session archive is already empty', async () => {
    const orc = await mgr.orchestrator()
    const r = await run(orc.id, 'delete_all_archived')
    expect(r.text).toBe('The session archive is already empty.')
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
    const { question } = await answered(orc.id, 'delete_all_archived', {}, 'deny')
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
    const gone = await trashed('Safe in the session archive')
    const caller = await newSession('Ordinary')
    for (const name of COMMANDS) {
      await expect(mgr.runOrchestratorTool(caller.id, name, { sessionId: gone.id }), name).rejects.toThrow(`Not a tool of this session: ${name}`)
      await expect(mgr.runOrchestratorTool(caller.id, 'centralu_run', { command: name, args: { sessionId: gone.id } }), name).rejects.toThrow(/Not a tool of this session/)
    }
    expect((await trash()).sessions.map((s) => s.id)).toEqual([gone.id])
    expect(card(caller.id)).toBeUndefined()
  })
})
