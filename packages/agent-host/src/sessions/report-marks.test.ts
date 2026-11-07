import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { Adapter, type Handle } from './fake-claude.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * "You will be told when it ends" (#646): a parent that started an agent without waiting is told when the child's turn
 * ends; the report it still owes is kept in the store's `report_marks`. A host that starts after the child's process went
 * drops the mark: that turn died with the old host. A turn an update cut goes on under the next host and its end is
 * reported from the mark (interruptions.test.ts, "a turn a linked hub's update cut").
 */

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-report-marks-')))
  events = []
})
afterEach(async () => {
  for (const mgr of hosts.splice(0)) await mgr.tenure.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function host() {
  const claude = new Adapter(true)
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'))
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

/** A parent that started a child without waiting, told it will hear when the child's turn ends */
async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.projectCreation.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'long work', wait: false })
  if (!started.ok) throw new Error(started.error)
  expect(started).toMatchObject({ state: 'working', reported: true })
  return { parent, child: started.sessionId }
}

/** What reaches the parent's model is a wake naming the source; the report's text is in the parent's conversation */
const reports = (h: Handle | undefined, child: string) => (h?.sent ?? []).filter((t) => t.includes(`sourceSessionId: ${child}`))

describe('the report a child owes its parent, across a restart (#646)', () => {
  it('is written to the store when it is asked for, and cleared once delivered', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    a.claude.handles.get(child)!.answer('done here')
    await eventually(() => reports(a.claude.handles.get(parent), child).length === 1)
    expect(store.children.listReportMarks()).toEqual([])
  })

  it('is dropped by a host that finds no process for the child: that turn died with the old host', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    await a.mgr.tenure.disposeAll()

    const c = host()
    expect(c.mgr.listSessions().find((s) => s.id === child)!.state).toBe('idle')
    expect(store.children.listReportMarks()).toEqual([])
    expect(c.mgr.processes.waitsOn((await parentAndChild(c)).parent)).not.toContain(child)
  })

  it('held over background work, it is dropped by a host that finds no process: the work went with the old one', async () => {
    const verify = { id: 'bg-verify', kind: 'shell' as const, description: 'pnpm verify', status: 'running' as const }
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.emitEvent({ type: 'background_tasks', sessionId: child, live: [verify] })
    a.claude.handles.get(child)!.answer('waiting for verify')
    await eventually(() => reports(a.claude.handles.get(parent), child).length === 1)
    await a.mgr.tenure.disposeAll()

    const c = host()
    expect(store.children.listReportMarks()).toEqual([])
    expect(store.settings.appSetting(`report_paused:${child}`)).toBeNull()
    expect(c.mgr.processes.waitsOn(parent)).toEqual([])
  })

  it('goes with the child or the parent when either is trashed', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    await a.mgr.trash.trashSession(child)
    expect(store.children.listReportMarks()).toEqual([])

    const second = await parentAndChild(a)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: second.child, callerSessionId: second.parent }])
    await a.mgr.trash.trashSession(second.parent)
    expect(store.children.listReportMarks()).toEqual([])
    expect(a.mgr.processes.waitsOn(parent)).toEqual([])
  })
})
