import { describe, expect, it } from 'vitest'
import type { HeadersMirror, PendingProjectDelete } from './link-deps.js'
import { heldProjectDeletes, PendingProjectDeletes } from './pending-project-deletes.js'

/**
 * The deletes a hub owes one linked machine (#2330), on their own: what is kept, what the hub's lists lose at once, and
 * what each answer of the machine does to the entry. Two real hosts are in away-project-delete.test.ts.
 */

/** A mirror in memory, both machines' lists in it */
function mirrorOf(lists: Record<string, { sessions: unknown[]; projects: unknown[] }>): HeadersMirror {
  return {
    read: (machine, kind) => lists[machine]?.[kind] ?? null,
    replace: (machine, kind, list) => void ((lists[machine] ??= { sessions: [], projects: [] })[kind] = list),
    upsertSession: () => {},
    patchSession: () => {},
    removeSession: (machine, sessionId) => {
      const l = lists[machine]
      if (l) l.sessions = l.sessions.filter((s) => (s as { id: string }).id !== sessionId)
    },
    forget: (machine) => void delete lists[machine],
  }
}

function world() {
  const lists = {
    m1: {
      projects: [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Blog' }],
      sessions: [{ id: 's1', projectId: 'p1' }, { id: 's2', projectId: 'p2' }, { id: 's3', projectId: 'p1' }],
    },
    m2: { projects: [{ id: 'p1', name: 'Other shop' }], sessions: [{ id: 's1', projectId: 'p1' }] },
  }
  const mirror = mirrorOf(lists)
  const list = heldProjectDeletes()
  const role = (id: 'm1' | 'm2') => {
    const heard: unknown[] = []
    const lines: string[] = []
    const machine = { id, name: id === 'm1' ? 'Desk' : 'Laptop' }
    const deletes = new PendingProjectDeletes({
      machine,
      list,
      mirror,
      // As the connection does for the machine's own event: the mirror follows, then the windows are told
      heard: (e) => {
        if (e.type === 'session_deleted') mirror.removeSession(id, e.sessionId)
        heard.push(e)
      },
      log: (line) => void lines.push(line),
    })
    return { deletes, heard, lines, machine }
  }
  const owed = () => list.read().map((d: PendingProjectDelete) => `${d.machine}.${d.projectId}`)
  return { lists, list, m1: role('m1'), m2: role('m2'), owed }
}

describe('the deletes a hub owes a linked machine (#2330)', () => {
  it('keeps the delete and takes the project and its sessions out of what the hub lists, at once', () => {
    const { lists, list, m1, m2 } = world()
    m1.deletes.keep('p1')
    expect(list.read()).toEqual([{ machine: 'm1', projectId: 'p1', name: 'Shop', at: expect.any(Number) }])
    expect(lists.m1).toEqual({ projects: [{ id: 'p2', name: 'Blog' }], sessions: [{ id: 's2', projectId: 'p2' }] })
    // Each session as the machine would have said it, then the projects: the windows drop the rows and read the list again
    expect(m1.heard).toEqual([{ type: 'session_deleted', sessionId: 's1' }, { type: 'session_deleted', sessionId: 's3' }, { type: 'projects_changed' }])
    expect(m1.lines).toEqual(['[links] Desk: project "Shop" was deleted here while it is away; it is deleted there when the link is back'])
    // Another machine's project of the same id is its own
    expect(lists.m2.projects).toHaveLength(1)
    expect(m2.deletes.any).toBe(false)
    expect(m1.deletes.any).toBe(true)
  })

  it('keeps one entry for a project asked twice, and each machine its own on the one list they share', () => {
    const { list, m1, m2, owed } = world()
    m1.deletes.keep('p1')
    m2.deletes.keep('p1')
    m1.deletes.keep('p2')
    m1.deletes.keep('p1')
    expect(owed()).toEqual(['m1.p1', 'm2.p1', 'm1.p2'])
    // The second ask found the project gone from the hub's list already: the entry and the log keep the name it was deleted under
    expect(list.read()[0]).toMatchObject({ name: 'Shop' })
    expect(m1.lines.at(-1)).toBe('[links] Desk: project "Shop" was deleted here while it is away; it is deleted there when the link is back')
    m1.deletes.forget()
    expect(owed()).toEqual(['m2.p1'])
    expect(m2.deletes.any).toBe(true)
  })

  it('keeps a delete of a project the hub does not list too, under its id: the machine may have it', () => {
    const { list, m1 } = world()
    m1.deletes.keep('p9')
    expect(list.read()).toEqual([{ machine: 'm1', projectId: 'p9', name: 'p9', at: expect.any(Number) }])
    expect(m1.heard).toEqual([{ type: 'projects_changed' }])
  })

  it('asks the machine for each, oldest first, and owes nothing after', async () => {
    const { m1, m2, owed } = world()
    m1.deletes.keep('p1')
    m2.deletes.keep('p1')
    m1.deletes.keep('p2')
    const calls: unknown[] = []
    await m1.deletes.apply(async (method, params) => void calls.push([method, params]), () => true)
    expect(calls).toEqual([['projects.delete', { projectId: 'p1' }], ['projects.delete', { projectId: 'p2' }]])
    expect(owed()).toEqual(['m2.p1'])
    expect(m1.lines.slice(2)).toEqual([
      '[links] Desk: deleted project "Shop", as asked here while it was away',
      '[links] Desk: deleted project "Blog", as asked here while it was away',
    ])
  })

  it('drops a delete the machine refused over a link that held, says so, and goes on to the next', async () => {
    const { m1, owed } = world()
    m1.deletes.keep('p1')
    m1.deletes.keep('p2')
    const asked: string[] = []
    await m1.deletes.apply(async (_method, params) => {
      const { projectId } = params as { projectId: string }
      asked.push(projectId)
      if (projectId === 'p1') throw new Error('Unknown method: projects.delete')
    }, () => true)
    expect(asked).toEqual(['p1', 'p2'])
    expect(owed()).toEqual([])
    expect(m1.lines[2]).toBe('[links] Desk: could not delete project "Shop", as asked here while it was away: Unknown method: projects.delete. The project is listed again')
  })

  it('keeps a delete whose answer the link went before, with the ones after it, for the next hello', async () => {
    const { m1, owed } = world()
    m1.deletes.keep('p1')
    m1.deletes.keep('p2')
    let up = true
    const asked: string[] = []
    const call = async (_method: string, params: unknown) => {
      asked.push((params as { projectId: string }).projectId)
      if (!up) throw new Error('connection closed')
    }
    up = false
    await m1.deletes.apply(call, () => up)
    expect(asked).toEqual(['p1'])
    expect(owed()).toEqual(['m1.p1', 'm1.p2'])
    expect(m1.lines[2]).toBe('[links] Desk: the link went before it answered the delete of project "Shop"; it is asked again when the link is back')
    up = true
    await m1.deletes.apply(call, () => up)
    expect(asked).toEqual(['p1', 'p1', 'p2'])
    expect(owed()).toEqual([])
  })

  it('does not ask again for a delete kept while the machine was being asked: that one waits for the next round', async () => {
    const { m1, owed } = world()
    m1.deletes.keep('p1')
    const asked: string[] = []
    await m1.deletes.apply(async (_method, params) => {
      asked.push((params as { projectId: string }).projectId)
      m1.deletes.keep('p2')
    }, () => true)
    expect(asked).toEqual(['p1'])
    expect(owed()).toEqual(['m1.p2'])
    expect(m1.deletes.any).toBe(true)
  })
})
