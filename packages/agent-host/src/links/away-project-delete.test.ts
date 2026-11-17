import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkDeps } from './link-deps.js'
import { cleanups, folder, runCleanups, seedSession } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { scriptedAdapters } from './scripted-agent.test-helpers.js'
import { storeProjectDeletes } from './stored.js'
import { Store } from '../dev-services/store.js'
import { realOs } from '../os/real.js'
import { SessionManager } from '../sessions/manager.js'
import { isObj } from '../json-value.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Deleting a project of a linked machine while the machine cannot be asked (#2330), with two real hosts: the hub answers
 * at once and lists the project no more, and the machine deletes it by its own `projects.delete` when the link is back.
 * The role on its own is in pending-project-deletes.test.ts.
 */

afterEach(runCleanups)

const WINDOW = { client: 1, rights: 'full', window: true } as const

const ids = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((x) => (isObj(x) && typeof x.id === 'string' ? [x.id] : [])) : [])

type Hub = Awaited<ReturnType<typeof hubHost>>

const view = (hub: Hub) => ({
  projects: async () => ids(await hub.router.handle('projects.list', {}, WINDOW)),
  sessions: async () => ids(await hub.router.handle('sessions.list', {}, WINDOW)),
  owed: () => storeProjectDeletes(hub.store).read().map((d) => `${d.machine}.${d.projectId}`),
})

const away = (hub: Hub) => eventually(() => !hub.links.get('m1')!.reachable)
const connected = (hub: Hub) => eventually(() => hub.machine().status === 'connected')

/** A machine and a hub linked to it, connected, the hub listing the machine's project and session; then the machine's host stops */
async function rig(o: { without?: readonly string[]; deps?: Partial<LinkDeps> } = {}) {
  const machine = await machineHost({ without: o.without })
  const lines: string[] = []
  const hub = await hubHost(machine.port, { deps: { log: (line) => void lines.push(line), ...o.deps } })
  await connected(hub)
  expect(await view(hub).projects()).toContain('m1.p-remote')
  expect(await view(hub).sessions()).toContain('m1.w1')
  const folder = machine.mgr.projectRegistry.projectRow('p-remote')!.path
  const there = {
    projects: () => machine.store.projects.listProjects().map((p) => p.id),
    archived: () => machine.store.trash.listTrash().map((t) => `${t.id} of ${t.record.projectName}`).sort(),
  }
  const stopMachine = async () => {
    await machine.server.close()
    await away(hub)
  }
  return { machine, hub, lines, folder, there, stopMachine }
}

describe('deleting a project of a linked machine that is away (#2330)', () => {
  it('answers at once, lists the project and its sessions no more, and deletes it there when the link is back', async () => {
    const { machine, hub, lines, folder, there, stopMachine } = await rig()
    await stopMachine()
    const told = vi.spyOn(hub.server, 'broadcast')
    expect(await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)).toEqual({ ok: true })
    // The hub's windows are told as the machine itself would have told them: the session's row goes, and the projects are read again
    expect(told.mock.calls.map(([e]) => e)).toEqual([{ type: 'session_deleted', sessionId: 'm1.w1' }, { type: 'projects_changed' }])
    expect(await view(hub).projects()).toEqual(['p-hub'])
    expect(await view(hub).sessions()).toEqual(['h1'])
    expect(view(hub).owed()).toEqual(['m1.p-remote'])
    // Nothing was written on the machine: its own host is the only writer of its store
    expect(there.projects()).toEqual(['p-remote'])
    expect(there.archived()).toEqual([])

    await machine.bounce()
    await connected(hub)
    expect(there.projects()).toEqual([])
    // Its sessions are in the machine's archive, where they can be restored, and its folder stays
    expect(there.archived()).toEqual(['w1 of remote-project'])
    expect(realOs().files.existsSync(folder)).toBe(true)
    expect(view(hub).owed()).toEqual([])
    expect(await view(hub).projects()).toEqual(['p-hub'])
    expect(await view(hub).sessions()).toEqual(['h1'])
    expect(lines).toContain('[links] Remote box: project "remote-project" was deleted here while it is away; it is deleted there when the link is back')
    expect(lines).toContain('[links] Remote box: deleted project "remote-project", as asked here while it was away')
  })

  it('still owes the delete after the hub is started again, and lists the project no more meanwhile', async () => {
    const { machine, hub, there, stopMachine } = await rig()
    await stopMachine()
    await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    await hub.stop()
    const again = await hubHost(machine.port, { store: hub.store })
    expect(await view(again).projects()).toEqual(['p-hub'])
    expect(await view(again).sessions()).toEqual(['h1'])
    expect(view(again).owed()).toEqual(['m1.p-remote'])

    await machine.bounce()
    await connected(again)
    expect(there.projects()).toEqual([])
    expect(there.archived()).toEqual(['w1 of remote-project'])
    expect(view(again).owed()).toEqual([])
    expect(await view(again).projects()).toEqual(['p-hub'])
  })

  it('lists its sessions no more either when the hub was started again before the delete, the machine still away', async () => {
    const { machine, hub, stopMachine } = await rig()
    await stopMachine()
    await hub.stop()
    // This run never heard the machine: what it lists of it is what the hub before it kept
    const again = await hubHost(machine.port, { store: hub.store })
    expect(again.links.get('m1')!.reachable).toBe(false)
    expect(await view(again).sessions()).toEqual(['h1', 'm1.w1'])
    const told = vi.spyOn(again.server, 'broadcast')
    await again.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    expect(told.mock.calls.map(([e]) => e)).toEqual([{ type: 'session_deleted', sessionId: 'm1.w1' }, { type: 'projects_changed' }])
    expect(await view(again).projects()).toEqual(['p-hub'])
    expect(await view(again).sessions()).toEqual(['h1'])
  })

  it('takes a session the machine got in the project meanwhile to its archive too', async () => {
    const { machine, hub, there, stopMachine } = await rig()
    await stopMachine()
    await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    // Used there while the hub could not reach it: a session the hub never heard of
    seedSession(machine.store, 'p-remote', 'w2', 'worker', 'ext-w2')
    await machine.swapForUpdate()
    await connected(hub)
    expect(there.projects()).toEqual([])
    expect(there.archived()).toEqual(['w1 of remote-project', 'w2 of remote-project'])
    expect(await view(hub).sessions()).toEqual(['h1'])
    expect(view(hub).owed()).toEqual([])
  })

  it('owes nothing for a project the machine deleted by itself meanwhile: its answer is the same', async () => {
    const { machine, hub, lines, there, stopMachine } = await rig()
    await stopMachine()
    await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    await machine.mgr.deleteProject('p-remote')
    await machine.bounce()
    await connected(hub)
    expect(there.archived()).toEqual(['w1 of remote-project'])
    expect(view(hub).owed()).toEqual([])
    expect(lines.filter((l) => l.includes('could not'))).toEqual([])
    expect(await view(hub).projects()).toEqual(['p-hub'])
  })

  it('lists the project again when the machine refused the delete, and does not ask it again', async () => {
    // A build from before `projects.delete`, or one that refuses it: the project is there, so the hub shows it
    const { machine, hub, lines, there, stopMachine } = await rig({ without: ['projects.delete'] })
    await stopMachine()
    await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    expect(await view(hub).projects()).toEqual(['p-hub'])
    await machine.bounce()
    await connected(hub)
    expect(there.projects()).toEqual(['p-remote'])
    expect(await view(hub).projects()).toContain('m1.p-remote')
    expect(await view(hub).sessions()).toContain('m1.w1')
    expect(view(hub).owed()).toEqual([])
    expect(lines.filter((l) => l.includes('could not delete project "remote-project"'))).toHaveLength(1)
  })

  it('deletes in the same hello a project deleted while the hello was reading the lists', async () => {
    const machine = await machineHost()
    let release = () => {}
    machine.holdMethod('projects.list', new Promise<void>((r) => (release = r)))
    const hub = await hubHost(machine.port)
    // The sessions list has answered, the projects list is held: the machine cannot be asked yet
    await eventually(() => ids(hub.links.get('m1')!.lastKnown('sessions')).includes('w1'))
    expect(hub.links.get('m1')!.reachable).toBe(false)
    expect(await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)).toEqual({ ok: true })
    release()
    await connected(hub)
    // Connected means nothing is owed: the machine was asked before the hub said so
    expect(view(hub).owed()).toEqual([])
    expect(machine.store.projects.listProjects()).toEqual([])
    expect(await view(hub).projects()).toEqual(['p-hub'])
    expect(await view(hub).sessions()).toEqual(['h1'])
  })

  it('owes a machine nothing once the person removed it from the hub', async () => {
    const { hub, stopMachine } = await rig()
    await stopMachine()
    await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' }, WINDOW)
    expect(view(hub).owed()).toEqual(['m1.p-remote'])
    await hub.router.handle('machines.remove', { machineId: 'm1' }, WINDOW)
    expect(view(hub).owed()).toEqual([])
  })

  it('keeps an agent’s delete the same way, once the machine did not come back for its call', async () => {
    const { machine, hub, there, stopMachine } = await rig({ deps: { callWaitMs: 50 } })
    await stopMachine()
    // No socket behind the call: an agent's, which waits for the machine first (`reachForCall`)
    expect(await hub.router.handle('projects.delete', { projectId: 'm1.p-remote' })).toEqual({ ok: true })
    expect(view(hub).owed()).toEqual(['m1.p-remote'])
    await machine.bounce()
    await connected(hub)
    expect(there.projects()).toEqual([])
    expect(there.archived()).toEqual(['w1 of remote-project'])
  })

  it('still refuses every other call to the machine while it is away', async () => {
    const { hub, stopMachine } = await rig()
    await stopMachine()
    await expect(hub.router.handle('projects.setTrusted', { projectId: 'm1.p-remote', trusted: false }, WINDOW)).rejects.toMatchObject({ data: { machine: 'm1', reason: 'unreachable' } })
    expect(view(hub).owed()).toEqual([])
  })
})

describe('a project deleted on a linked machine itself (#2330)', () => {
  it('is said to the hub, whose windows read the projects again', async () => {
    const { machine, hub } = await rig()
    const told = vi.spyOn(hub.server, 'broadcast')
    await machine.mgr.deleteProject('p-remote')
    await eventually(() => told.mock.calls.some(([e]) => e.type === 'projects_changed'))
    expect(await view(hub).projects()).toEqual(['p-hub'])
  })

  it('is said once its sessions are in the archive and its row is gone, and not for a project the host does not have', async () => {
    const store = new Store()
    store.projects.addProject({ id: 'p1', path: folder(), name: 'one' })
    seedSession(store, 'p1', 's1')
    const said: string[] = []
    const mgr = new SessionManager(store, scriptedAdapters(), (e) => {
      if (e.type === 'projects_changed') said.push(`projects_changed with ${store.projects.listProjects().length} projects`)
      else if (e.type === 'session_deleted') said.push(`session_deleted ${e.sessionId}`)
    })
    cleanups.push(() => mgr.tenure.disposeAll())
    await mgr.deleteProject('p1')
    expect(said).toEqual(['session_deleted s1', 'projects_changed with 0 projects'])
    await mgr.deleteProject('p1')
    expect(said).toHaveLength(2)
  })
})
