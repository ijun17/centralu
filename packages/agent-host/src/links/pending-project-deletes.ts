import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'
import type { HeadersMirror, PendingProjectDelete, PendingProjectDeleteList } from './link-deps.js'

/**
 * The projects of one linked machine the person deleted while the machine could not be asked (#2330,
 * docs/plans/remote-hub.md §5 "Recovery").
 *
 * The machine's own host is the only writer of its store (§1), so the hub deletes nothing there by itself: it keeps the
 * delete, takes the project and its sessions out of what it last heard from the machine (the headers mirror, which every
 * list of an away machine is read from, so no reader filters anything), and asks the machine's own `projects.delete` at
 * its next hello, before its lists are read. The sessions go to the archive there, where they can be restored, and the
 * folder stays, as for a delete while it was connected.
 *
 * A delete is owed only until the machine was asked over a link that held. Deleted, refused or not answered in time, the
 * entry is gone and the machine's lists, read right after, say what is there: a project the machine refused to delete is
 * listed again rather than hidden while it exists. Only a link that went before the answer keeps the entry for the next
 * hello.
 */

/** Kept for this run only: a hub without a store behind its links (tests) */
export function heldProjectDeletes(): PendingProjectDeleteList {
  let held: readonly PendingProjectDelete[] = []
  return { read: () => [...held], write: (list) => void (held = list) }
}

/** What the role reads of its machine */
type Host = {
  /** The connection itself: its name can change while it is linked */
  readonly machine: { readonly id: string; readonly name: string }
  readonly list: PendingProjectDeleteList
  readonly mirror: HeadersMirror
  /** An event as the machine itself would have said it: the mirror follows and the hub's windows are told */
  heard(event: { type: 'session_deleted'; sessionId: string } | { type: 'projects_changed' }): void
  log(line: string): void
}

export class PendingProjectDeletes {
  constructor(private readonly host: Host) {}

  /** This machine's, oldest first */
  private owed(): PendingProjectDelete[] {
    return this.host.list.read().filter((d) => d.machine === this.host.machine.id)
  }

  private drop(keeps: (d: PendingProjectDelete) => boolean): void {
    const all = this.host.list.read()
    const left = all.filter((d) => d.machine !== this.host.machine.id || keeps(d))
    if (left.length !== all.length) this.host.list.write(left)
  }

  /** Whether a delete is still owed: the machine's lists are read once none is (`onHello`) */
  get any(): boolean {
    return this.owed().length > 0
  }

  /**
   * Keeps the delete of `projectId` (the machine's own id) and takes the project and its sessions out of the hub's
   * lists at once. Asked twice, it is kept once
   */
  keep(projectId: string): void {
    const { machine, mirror } = this.host
    const id = machine.id
    const projects = mirror.read(id, 'projects') ?? []
    const project = projects.find((p) => isObj(p) && p.id === projectId)
    const name = isObj(project) && typeof project.name === 'string' ? project.name : projectId
    // Written first: a hub that stops right after still deletes it there, and its windows read the lists again at its start
    if (!this.owed().some((d) => d.projectId === projectId)) this.host.list.write([...this.host.list.read(), { machine: id, projectId, name, at: Date.now() }])
    for (const s of mirror.read(id, 'sessions') ?? []) {
      if (isObj(s) && s.projectId === projectId && typeof s.id === 'string') this.host.heard({ type: 'session_deleted', sessionId: s.id })
    }
    if (project !== undefined) mirror.replace(id, 'projects', projects.filter((p) => p !== project))
    this.host.heard({ type: 'projects_changed' })
    this.host.log(`[links] ${machine.name}: project "${name}" was deleted here while it is away; it is deleted there when the link is back`)
  }

  /**
   * Asks the machine for every delete owed, oldest first. `call` is one call on it; `linkUp` says whether the link the
   * calls went over still stands, read after a call that failed
   */
  async apply(call: (method: string, params: unknown) => Promise<unknown>, linkUp: () => boolean): Promise<void> {
    const { name } = this.host.machine
    const log = (line: string) => this.host.log(line)
    for (const d of this.owed()) {
      try {
        // Its answer for a project it no longer has is ok too: deleted there meanwhile, or by an earlier try whose answer was lost
        await call('projects.delete', { projectId: d.projectId })
        log(`[links] ${name}: deleted project "${d.name}", as asked here while it was away`)
      } catch (err) {
        if (!linkUp()) {
          log(`[links] ${name}: the link went before it answered the delete of project "${d.name}"; it is asked again when the link is back`)
          return
        }
        log(`[links] ${name}: could not delete project "${d.name}", as asked here while it was away: ${errorMessage(err)}. The project is listed again`)
      }
      this.drop((x) => x.projectId !== d.projectId)
    }
  }

  /** The machine was removed from the hub: nothing is owed to it */
  forget(): void {
    this.drop(() => false)
  }
}
