import { BackgroundTask } from '@cc/protocol'
import { z } from 'zod'
import { NOT_REACHABLE } from '../adapters/contract.js'
import { isObj } from '../json-value.js'
import { sessionAddress } from '../mail/address.js'
import type { AcrossPeers } from '../mail/across.js'
import { entryOf, type FoundEntry } from '../mail/find.js'
import { startingHub } from '../sessions/hub-preset.js'
import type { LinkedHubs } from './linked-hubs.js'

/**
 * What mail across linked machines reaches (#2067 items 2 and 3, `MailAcross.usePeers`), wired one way for main.ts and
 * the tests: the machines this host links as a hub, and the hubs that link it as a machine. A host may be both
 */

/** A linked machine as the hub's links hold it */
type Machine = {
  id: string
  name: string
  reachable: boolean
  call(method: string, params: unknown): Promise<unknown>
  lastKnown(kind: 'sessions' | 'projects'): unknown[] | null
}

export function mailPeers(o: {
  /** This host's mail id (`hubSelfId`): a machine's session is `session:<it>/<machine>.<id>` here */
  hostId: string
  selfName: () => string
  /** The machines this host links, when it is a hub */
  machines?: { get(id: string): Machine | undefined; all(): Machine[] }
  /** The session here that started a machine's child (`LinkedHost.remoteAgentParent`) */
  parentOf?: (qualifiedId: string) => string | undefined
  /** The hubs that link this host, when it is a machine */
  hubs?: Pick<LinkedHubs, 'peer' | 'mailHubs'> & Partial<Pick<LinkedHubs, 'onMailOffer'>>
  /** Where the hub that started a session here is recorded (`startingHub`) */
  settings?: { appSetting(key: string): string | null }
}): AcrossPeers {
  const { machines, hubs, settings } = o
  const projectNames = (m: Machine): Map<string, string> =>
    new Map((m.lastKnown('projects') ?? []).flatMap((p) => (isObj(p) && typeof p.id === 'string' && typeof p.name === 'string' ? [[p.id, p.name] as const] : [])))
  return {
    selfName: o.selfName,
    onConnect: (fn) => {
      hubs?.onMailOffer?.(() => fn())
    },
    ...(o.parentOf ? { parentOf: o.parentOf } : {}),
    ...(machines
      ? {
          machine: (id: string) => {
            const m = machines.get(id)
            return m && { id: m.id, name: m.name, reachable: m.reachable, call: (method: string, params: unknown) => m.call(method, params) }
          },
          machineSession: (machineId: string, sessionId: string) => {
            const m = machines.get(machineId)
            const row = (m?.lastKnown('sessions') ?? []).find((s) => isObj(s) && s.id === sessionId)
            return m && isObj(row) && typeof row.name === 'string' ? `${row.name} on ${m.name}` : undefined
          },
          machineDirectory: () => {
            const entries: FoundEntry[] = []
            const away: { name: string; why: string }[] = []
            for (const m of machines.all()) {
              // Mail to a machine that is down is refused at once: its sessions are not offered as recipients
              if (!m.reachable) {
                away.push({ name: m.name, why: NOT_REACHABLE })
                continue
              }
              const names = projectNames(m)
              for (const s of m.lastKnown('sessions') ?? []) {
                if (!isObj(s) || typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.kind !== 'string' || typeof s.state !== 'string' || typeof s.createdAt !== 'number') continue
                const projectId = typeof s.projectId === 'string' ? s.projectId : null
                entries.push(
                  entryOf(
                    {
                      id: s.id,
                      name: s.name,
                      kind: s.kind,
                      state: s.state,
                      askedBy: typeof s.askedBy === 'string' ? s.askedBy : null,
                      startedFromHub: s.startedFromHub === true,
                      waitingSince: typeof s.waitingSince === 'number' ? s.waitingSince : null,
                      createdAt: s.createdAt,
                      ...factsOf(s),
                    },
                    { address: sessionAddress(o.hostId, `${m.id}.${s.id}`), project: projectId === null ? null : (names.get(projectId) ?? projectId), machine: m.name, machineId: m.id },
                  ),
                )
              }
            }
            return { entries, away }
          },
        }
      : {}),
    ...(hubs
      ? {
          hub: (id: string) => hubs.peer(id),
          hubs: () => hubs.mailHubs(),
          ...(settings ? { startingHub: (sessionId: string) => startingHub(settings, sessionId) } : {}),
        }
      : {}),
  }
}

/**
 * What a mirrored session's look and busyness read beyond its state (`agentLook`, `atRest`), as its machine pushed them: its
 * background work (paused, #2146), how its turn was cut short (stopped), and the cards open on it (waiting), as this host's
 * own rows carry them
 */
function factsOf(s: Record<string, unknown>): { backgroundTasks?: BackgroundTask[]; interruption?: unknown; pendingApproval?: unknown; pendingQuestions?: unknown[] } {
  const tasks = z.array(BackgroundTask).safeParse(s.backgroundTasks)
  return {
    ...(tasks.success ? { backgroundTasks: tasks.data } : {}),
    ...(s.interruption ? { interruption: s.interruption } : {}),
    ...(s.pendingApproval ? { pendingApproval: s.pendingApproval } : {}),
    ...(Array.isArray(s.pendingQuestions) ? { pendingQuestions: s.pendingQuestions } : {}),
  }
}
