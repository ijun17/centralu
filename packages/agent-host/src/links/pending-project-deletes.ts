import { errorMessage } from '@cc/protocol'
import { isObj } from '../json-value.js'
import { older } from '../mail/across-core.js'
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
 * A delete is owed until the machine did it. One the machine failed, or did not answer in time, stays owed and is asked
 * again (linked-machine-connection.ts `readLists`): a store that was busy answers the next try. A link that went before
 * the answer keeps it for the next hello and counts as no try. The hub gives up, and the entry is gone, in two cases:
 * the machine's build has no `projects.delete`, which no later try changes, and `TRIES` failures in a row in this run of
 * the hub. The person is then told in the Inbox (`tell`), since the project they deleted is listed again.
 *
 * Between a failed try and the next, the machine's lists say what is there, so the project is listed again: the hub
 * hides nothing a machine that answers says it has.
 */

/** How many failures in a row end a delete: more than a busy store gives, few enough that a machine that cannot do it is not asked for good */
export const TRIES = 5

/** What the role reads of its machine */
type Host = {
  /** The connection itself: its name can change while it is linked */
  readonly machine: { readonly id: string; readonly name: string }
  readonly list: PendingProjectDeleteList
  readonly mirror: HeadersMirror
  /** An event as the machine itself would have said it: the mirror follows and the hub's windows are told */
  heard(event: { type: 'session_deleted'; sessionId: string } | { type: 'projects_changed' }): void
  /** A notice from Centralu in the person's Inbox, written once per `key` (`LinkDeps.tellPerson`) */
  tell(text: string, key: string): void
  log(line: string): void
}

export class PendingProjectDeletes {
  /** The failures in a row of each delete asked in this run, by project */
  private readonly failed = new Map<string, number>()

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

  /** Whether a delete is still owed: one the machine failed is asked again while the link holds (`readLists`) */
  get any(): boolean {
    return this.owed().length > 0
  }

  /** Whether one is owed that the machine was not asked for yet: kept while it was being asked for the others */
  get unasked(): boolean {
    return this.owed().some((d) => !this.failed.has(d.projectId))
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
    const owed = this.owed().find((d) => d.projectId === projectId)
    // Asked again, the hub lists it no more: the name is the one it was kept under
    const name = owed?.name ?? (isObj(project) && typeof project.name === 'string' ? project.name : projectId)
    // Written first: a hub that stops right after still deletes it there, and its windows read the lists again at its start
    if (!owed) this.host.list.write([...this.host.list.read(), { machine: id, projectId, name, at: Date.now() }])
    for (const s of mirror.read(id, 'sessions') ?? []) {
      if (isObj(s) && s.projectId === projectId && typeof s.id === 'string') this.host.heard({ type: 'session_deleted', sessionId: s.id })
    }
    if (project !== undefined) mirror.replace(id, 'projects', projects.filter((p) => p !== project))
    this.host.heard({ type: 'projects_changed' })
    this.host.log(`[links] ${machine.name}: project "${name}" was deleted here while it is away; it is deleted there when the link is back`)
  }

  /**
   * Asks the machine for every delete owed, at its hello and again while one it failed stays owed. `linkUp` says whether
   * the link still holds after a call failed: an answer that never came over a link that went is no try
   */
  async apply(call: (method: string, params: unknown) => Promise<unknown>, linkUp: () => boolean): Promise<void> {
    const { name } = this.host.machine
    const log = (line: string) => this.host.log(line)
    for (const d of this.owed()) {
      try {
        await call('projects.delete', { projectId: d.projectId })
        log(`[links] ${name}: deleted project "${d.name}", as asked here while it was away`)
        // Listed again since a try that failed: the windows read the projects again, also where the machine's build says nothing of a delete
        if (this.failed.has(d.projectId)) this.host.heard({ type: 'projects_changed' })
      } catch (err) {
        if (!linkUp()) {
          log(`[links] ${name}: the link went before it answered the delete of project "${d.name}"; it is asked again when the link is back`)
          return
        }
        const failed = (this.failed.get(d.projectId) ?? 0) + 1
        const why = older(err) ? `${name} runs an older Centralu, which cannot do this` : errorMessage(err)
        if (!older(err) && failed < TRIES) {
          this.failed.set(d.projectId, failed)
          log(`[links] ${name}: could not delete project "${d.name}", as asked here while it was away: ${why}. It is asked again`)
          continue
        }
        log(`[links] ${name}: could not delete project "${d.name}", as asked here while it was away: ${why}. The project is listed again`)
        this.host.tell(
          `Could not delete project "${d.name}" on ${name}: ${why}. It was deleted here while ${name} was not connected, and it is listed again. ${older(err) ? `Update Centralu on ${name}, then delete it again.` : 'Delete it again to try once more.'}`,
          `project-delete:${d.machine}:${d.projectId}:${d.at}`,
        )
      }
      this.failed.delete(d.projectId)
      this.drop((x) => x.projectId !== d.projectId)
    }
  }

  /** The machine was removed from the hub: nothing is owed to it */
  forget(): void {
    this.failed.clear()
    this.drop(() => false)
  }
}
