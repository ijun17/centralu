import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { sessionAddress } from './address.js'
import { deliveryCore, turnEnder } from './delivery.test-helpers.js'
import { hostMail, type HostMailSessions } from './host-mail.js'

export const HOST = 'hub-aaaaaaaa'
export const NOW = 1_800_000_000_000
export const at = (id: string): string => sessionAddress(HOST, id)

export type Sess = { name: string; projectId: string | null; askedBy?: string; kind?: 'worker' | 'assistant' }
const SESSIONS: Record<string, Sess> = {
  a: { name: 'alpha', projectId: 'p1' },
  b: { name: 'beta', projectId: 'p1' },
  c: { name: 'gamma', projectId: 'p2' },
  x: { name: 'xi', projectId: 'px' },
  orc: { name: 'Assistant', projectId: null, kind: 'assistant' },
  w: { name: 'worker', projectId: 'p1', askedBy: 'a' },
  o: { name: 'orchestrated', projectId: 'p1', askedBy: 'orc' },
}

/**
 * The host's mail as `main.ts` wires it (`hostMail`), over a real store and a table of sessions the test edits, with a clock and a scheduler that move
 * only when the test moves them. Pass the store of an earlier world to start "the next host" on it (a restart, an update's stop and continue)
 */
export function hostWorld(opts: { store?: Store; clock?: { t: number }; kept?: ReadonlySet<string>; fromHub?: readonly string[]; extra?: Record<string, Sess>; work?: HostMailSessions['work']; note?: HostMailSessions['note']; readsSession?: HostMailSessions['readsSession'] } = {}) {
  const store = opts.store ?? new Store()
  for (const [id, trusted] of [['p1', true], ['p2', true], ['px', false]] as const) {
    if (!store.projects.listProjects().some((p) => p.id === id)) store.projects.addProject({ id, path: `/${id}`, name: id === 'px' ? 'Pex' : id, trusted })
  }
  const clock = opts.clock ?? { t: NOW }
  const { states, delivered, behaviour, deliver, schedule, advance, to } = deliveryCore(clock)
  const table: Record<string, Sess> = { ...SESSIONS, ...opts.extra }
  /** The question cards each session holds, by request id: what a watch's baseline and its catch-up read */
  const cards = new Map<string, string[]>()
  /** What else a session's info says, as a test sets it (its background work, its state after a failure) */
  const more = new Map<string, Partial<SessionInfo>>()
  /** Sessions whose adopted process has not listed its background work yet (`RestartPolicy.backgroundKnown`) */
  const workUnknown = new Set<string>()
  const info = (id: string): SessionInfo | undefined => {
    const s = table[id]
    const pendingQuestions = (cards.get(id) ?? []).map((requestId) => ({ requestId }))
    return s && ({ id, name: s.name, projectId: s.projectId, askedBy: s.askedBy ?? null, ...(opts.fromHub?.includes(id) ? { startedFromHub: true } : {}), kind: s.kind ?? 'worker', state: states.get(id)?.kind === 'busy' ? 'working' : 'idle', pendingQuestions, pendingApproval: null, ...more.get(id) } as unknown as SessionInfo)
  }
  const sessions: HostMailSessions = {
    sessionInfo: info,
    listSessions: () => Object.keys(table).flatMap((id) => info(id) ?? []),
    canReadMail: () => true,
    assistantId: () => 'orc',
    mailCommand: () => false,
    keptInTurn: (id) => opts.kept?.has(id) ?? false,
    mailSessions: () => ({
      receiver: (id) => (table[id] ? (states.get(id) ?? { kind: 'ready', live: true, quiet: true }) : { kind: 'gone' }),
      note: () => {},
      deliver,
    }),
    projectTrusted: (projectId) => store.projects.listProjects().some((p) => p.id === projectId && p.trusted),
    ...(opts.work ? { work: opts.work } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    readsSession: opts.readsSession ?? (() => ({ untrusted: false })),
    backgroundKnown: (id) => !workUnknown.has(id),
  }
  const m = hostMail(store, sessions, {
    hostId: HOST,
    now: () => clock.t,
    delivery: { schedule },
  })
  const row = (id: string, recipient: string) => store.mailbox.recipient(id, recipient)
  return { store, clock, states, delivered, behaviour, advance, endTurn: turnEnder(m.turns), to, row, table, cards, more, workUnknown, ...m, mail: m.service, stop: () => m.delivery.stop() }
}
