import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { deliveryCore, turnEnder } from './delivery.test-helpers.js'
import { hostMail, type HostMailSessions } from './host-mail.js'

export const HOST = 'hub-aaaaaaaa'
export const NOW = 1_800_000_000_000
export const at = (id: string): string => sessionAddress(HOST, id)

type Sess = { name: string; projectId: string | null; askedBy?: string; kind?: 'worker' | 'orchestrator' }
const SESSIONS: Record<string, Sess> = {
  a: { name: 'alpha', projectId: 'p1' },
  b: { name: 'beta', projectId: 'p1' },
  c: { name: 'gamma', projectId: 'p2' },
  x: { name: 'xi', projectId: 'px' },
  orc: { name: 'orchestrator', projectId: null, kind: 'orchestrator' },
  w: { name: 'worker', projectId: 'p1', askedBy: 'a' },
  o: { name: 'orchestrated', projectId: 'p1', askedBy: 'orc' },
}

/**
 * The host's mail as `main.ts` wires it (`hostMail`), over a real store and a table of sessions the test edits, with a clock and a scheduler that move
 * only when the test moves them. Pass the store of an earlier world to start "the next host" on it (a restart, an update's stop and continue)
 */
export function hostWorld(opts: { store?: Store; clock?: { t: number }; kept?: ReadonlySet<string>; oldOwes?: (ownerId: string, childId: string) => boolean; fromHub?: readonly string[] } = {}) {
  const store = opts.store ?? new Store()
  for (const [id, trusted] of [['p1', true], ['p2', true], ['px', false]] as const) {
    if (!store.projects.listProjects().some((p) => p.id === id)) store.projects.addProject({ id, path: `/${id}`, name: id === 'px' ? 'Pex' : id, trusted })
  }
  const clock = opts.clock ?? { t: NOW }
  const { states, delivered, behaviour, deliver, schedule, advance, to } = deliveryCore(clock)
  const info = (id: string): SessionInfo | undefined => {
    const s = SESSIONS[id]
    return s && ({ id, name: s.name, projectId: s.projectId, askedBy: s.askedBy ?? null, ...(opts.fromHub?.includes(id) ? { startedFromHub: true } : {}), kind: s.kind ?? 'worker', state: states.get(id)?.kind === 'busy' ? 'working' : 'idle' } as unknown as SessionInfo)
  }
  const sessions: HostMailSessions = {
    sessionInfo: info,
    listSessions: () => Object.keys(SESSIONS).flatMap((id) => info(id) ?? []),
    canReadMail: () => true,
    orchestratorId: () => 'orc',
    orchestratorAsks: () => null,
    mailCommand: () => false,
    keptInTurn: (id) => opts.kept?.has(id) ?? false,
    oldOwes: opts.oldOwes ?? (() => false),
    mailSessions: () => ({
      receiver: (id) => (SESSIONS[id] ? (states.get(id) ?? { kind: 'ready', live: true, quiet: true }) : { kind: 'gone' }),
      note: () => {},
      deliver,
    }),
  }
  const m = hostMail(store, sessions, {
    hostId: HOST,
    now: () => clock.t,
    delivery: { schedule },
  })
  const row = (id: string, recipient: string) => store.mailbox.recipient(id, recipient)
  return { store, clock, states, delivered, behaviour, advance, endTurn: turnEnder(m.turns), to, row, ...m, mail: m.service, stop: () => m.delivery.stop() }
}
