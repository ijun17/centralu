import type Database from 'better-sqlite3'
import { Store } from '../dev-services/store.js'
import type { MailRow } from '../dev-services/store/mailbox.js'
import { parseAddress, sessionAddress } from './address.js'
import { MessageService, type SendInput, type SendResult, type TurnNow } from './messages.js'
import { mailReach, type ReachHost } from './reach.js'
import { refusalReason } from './rules.js'

export const HOST = 'hub-aaaaaaaa'
export const NOW = 1_800_000_000_000
export const addr = (id: string): string => sessionAddress(HOST, id)
const idOf = (address: string): string => {
  const party = parseAddress(address)
  return party?.kind === 'session' ? party.sessionId : ''
}
/** Two sessions of the trusted project p1, one of the trusted p2, two of the untrusted px, the Assistant, and a child of A */
export const A = addr('a')
export const B = addr('b')
export const C = addr('c')
export const X = addr('x')
export const Y = addr('y')
export const ORC = addr('orc')
export const W = addr('w')

type Sess = { projectId: string | null; askedBy?: string | null; here?: boolean; canReadMail?: boolean; name?: string }

/** A real in-memory store under a message service whose host is a table the test edits */
export function world() {
  const store = new Store()
  const db = (store as unknown as { db: Database.Database }).db
  const sessions = new Map<string, Sess>([
    ['a', { projectId: 'p1', name: 'alpha' }],
    ['b', { projectId: 'p1', name: 'beta' }],
    ['c', { projectId: 'p2', name: 'gamma' }],
    ['x', { projectId: 'px', name: 'xi' }],
    ['y', { projectId: 'px', name: 'upsilon' }],
    ['orc', { projectId: null, name: 'Assistant' }],
    ['w', { projectId: 'p1', askedBy: 'a', name: 'worker' }],
  ])
  const projects = new Map<string, { trusted: boolean; name?: string }>([
    ['p1', { trusted: true, name: 'Pone' }],
    ['p2', { trusted: true }],
    ['px', { trusted: false, name: 'Pex' }],
  ])
  const state = { asks: true }
  const host: ReachHost = {
    hostId: HOST,
    session: (id) => {
      const s = sessions.get(id)
      return s && { projectId: s.projectId, askedBy: s.askedBy ?? null, here: s.here ?? true, canReadMail: s.canReadMail ?? true, host: 'here', ...(s.name ? { name: s.name } : {}) }
    },
    assistantId: () => 'orc',
    assistantAsks: () => state.asks,
    appCalledBy: () => false,
    project: (id) => projects.get(id),
    // The sessions of one project, and of the Assistant's none, are one group
    askGroupMembers: (a) => [...sessions].filter(([, s]) => s.projectId !== null && s.projectId === sessions.get(idOf(a))?.projectId).map(([id]) => addr(id)),
  }
  const clock = { t: NOW }
  const turns = new Map<string, TurnNow>()
  const reach = mailReach(host)
  const mail = new MessageService(store.mailbox, reach, { hostId: HOST, now: () => clock.t, turn: (a) => turns.get(a) ?? null })

  /** The session is in a turn that `starter` started (a row in `mail_turns`, as `MailTurns.begin` writes it) */
  function startTurn(session: string, starter: string | null, over: Partial<TurnNow> = {}): TurnNow {
    const sid = idOf(session)
    const turnSeq = (turns.get(session)?.turnSeq ?? 0) + 1
    const turn: TurnNow = { turnSeq, by: starter === null ? 'cli' : 'mail', starter, messageId: null, asker: null, startedAt: clock.t, ...over }
    db.prepare(`INSERT INTO mail_turns (session_id, turn_seq, started_by, started_at, starter_id) VALUES (?, ?, ?, ?, ?)`).run(sid, turnSeq, turn.by, clock.t, starter)
    turns.set(session, turn)
    return turn
  }

  /** `send` with the clock moved on first, so a test's messages come in the order it wrote them */
  function send(sender: string, input: Partial<SendInput> & { text: string }): SendResult {
    clock.t += 10
    return mail.send(sender, { to: [], ...input })
  }
  const message = (id: string): MailRow => {
    const m = store.mailbox.message(id)
    if (!m) throw new Error(`no message ${id}`)
    return m
  }
  const rowOf = (id: string, recipient: string) => {
    const r = store.mailbox.recipient(id, recipient)
    if (!r) throw new Error(`no row ${id} for ${recipient}`)
    return r
  }
  return { store, db, mail, reach, records: store.mailbox, clock, sessions, projects, state, turns, startTurn, send, message, rowOf }
}

/** What a refused call said it was refused for; 'NOT REFUSED' when it was not */
export function refusedFor(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return refusalReason(e) ?? `not a refusal: ${String(e)}`
  }
  return 'NOT REFUSED'
}

/** `refusedFor` of a call that answers later */
export async function refusedForAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    return refusalReason(e) ?? `not a refusal: ${String(e)}`
  }
  return 'NOT REFUSED'
}
