import { createListeners } from '@cc/common'
import { errorMessage, type WatchView } from '@cc/protocol'
import { z } from 'zod'
import type { PrChecks } from '../dev-services/git-pr.js'
import { parseJson } from '../dev-services/store/json.js'
import type { MailboxRecords, WatchRow } from '../dev-services/store/mailbox.js'
import { PERSON, parseAddress, sessionAddress } from './address.js'
import { openTaskParties } from './delegation.js'
import { quoted } from './frame.js'
import { UlidMaker, watchIdOf } from './ids.js'
import type { MessageService } from './messages.js'
import { HOUR_MS, MINUTE_MS, WARNING_TEXT, WATCH, hourlyKey, refuse } from './rules.js'

/*
 * A watch (docs/plans/mailbox.md §18): a condition a session asks Centralu to keep for it. When it changes, the session that set it gets one
 * notice through `MessageService.notice`, which MailDelivery brings like any other mail. The shape first, then the one owner of the rows.
 */

/**
 * What a watch waits for: a time (`in` and `at` once at `slotMs`, `every` at each slot), a change of a session since its baseline, or the end of a
 * pull request's checks on its head (`headOid`, the head the wait is for: a push starts it again)
 */
export type WatchSpec =
  | { source: 'time'; kind: 'in' | 'at' | 'every'; slotMs: number; periodMin?: number }
  | { source: 'session'; target: string; baselineTurn: number; baselineCards: string[] }
  | { source: 'pr'; project: string; number: number; headOid: string }

/** `active` until it ends; every other state is an end and never goes back */
export const WATCH_STATES = ['active', 'fired', 'expired', 'cancelled', 'gone'] as const
export type WatchState = (typeof WATCH_STATES)[number]
export const WATCH_ENDED_BY = ['owner', 'person', 'host'] as const
export type WatchEndedBy = (typeof WATCH_ENDED_BY)[number]

/** What changed in a watched session (the `reason` its notice's frame line says) */
export type SessionChange = 'turn_ended' | 'asked' | 'stopped' | 'gone'

export type Watch = Omit<WatchRow, 'source' | 'spec' | 'state' | 'endedBy'> & { spec: WatchSpec; state: WatchState; endedBy: WatchEndedBy | null }

/** The stored `spec` beside the `source` and `target` columns, read at this boundary: a row that does not read is not this build's to touch */
const StoredSpec = {
  time: z.object({ kind: z.enum(['in', 'at', 'every']), slotMs: z.number(), periodMin: z.number().optional() }),
  session: z.object({ baselineTurn: z.number(), baselineCards: z.array(z.string()) }),
  pr: z.object({ project: z.string(), number: z.number(), headOid: z.string() }),
}

function readWatch(row: WatchRow): Watch | undefined {
  const state = WATCH_STATES.find((s) => s === row.state)
  const endedBy = row.endedBy === null ? null : WATCH_ENDED_BY.find((b) => b === row.endedBy)
  if (!state || endedBy === undefined) return undefined
  const raw = parseJson(row.spec)
  let spec: WatchSpec | undefined
  if (row.source === 'time') {
    const t = StoredSpec.time.safeParse(raw)
    spec = t.success ? { source: 'time', ...t.data } : undefined
  } else if (row.source === 'session') {
    const s = StoredSpec.session.safeParse(raw)
    spec = s.success ? { source: 'session', target: row.target, ...s.data } : undefined
  } else if (row.source === 'pr') {
    const pr = StoredSpec.pr.safeParse(raw)
    spec = pr.success ? { source: 'pr', ...pr.data } : undefined
  }
  return spec && { ...row, spec, state, endedBy }
}

function writeWatch(w: Watch): WatchRow {
  const { spec } = w
  if (spec.source === 'session') return { ...w, source: spec.source, target: spec.target, spec: JSON.stringify({ baselineTurn: spec.baselineTurn, baselineCards: spec.baselineCards }) }
  const { source, ...stored } = spec
  return { ...w, source, spec: JSON.stringify(stored) }
}

/** Whether `to` names a time rather than a session (§18.2) */
export const isTimeWatch = (to: string): boolean => /^(in|at|every)\s/i.test(to.trim())

/** The pull request `to` names (`#123`), or null (§18.3) */
export const prNumberOf = (to: string): number | null => {
  const m = /^#(\d{1,9})$/.exec(to.trim())
  return m ? Number(m[1]) : null
}

/** "The checks on #123 finished: 2 failed, 1 cancelled", or "No checks ran on #123" when its head has none */
const checksEnded = (number: number, r: PrChecks): string =>
  r.total === 0 ? `No checks ran on #${number}` : `The checks on #${number} finished: ${r.failed === 0 ? 'none' : r.failed} failed${r.cancelled ? `, ${r.cancelled} cancelled` : ''}`

/** The time spec `to` names, from `now`, or a refusal that says why not */
function timeSpec(to: string, now: number): Extract<WatchSpec, { source: 'time' }> {
  const t = to.trim()
  const units: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: 24 * HOUR_MS }
  const span = /^(in|every)\s+(\d{1,6})\s*([mhd])$/i.exec(t)
  if (span) {
    const ms = Number(span[2]) * (units[(span[3] ?? 'm').toLowerCase()] ?? MINUTE_MS)
    if (span[1]?.toLowerCase() === 'every') {
      if (ms < WATCH.everyAtLeastMs) throw refuse('bad_value', `"every" is at least ${WATCH.everyAtLeastMs / MINUTE_MS} minutes.`)
      return { source: 'time', kind: 'every', slotMs: now + ms, periodMin: ms / MINUTE_MS }
    }
    if (ms <= 0 || ms > WATCH.aheadAtMostMs) throw refuse('bad_value', 'a time is at most 7 days ahead.')
    return { source: 'time', kind: 'in', slotMs: now + ms }
  }
  const at = /^at\s+(\d{1,2}):(\d{2})$/i.exec(t)
  if (at && Number(at[1]) < 24 && Number(at[2]) < 60) {
    // Resolved to an instant once, here (§18.12: a clock change or DST later does not move it)
    const d = new Date(now)
    d.setHours(Number(at[1]), Number(at[2]), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return { source: 'time', kind: 'at', slotMs: d.getTime() }
  }
  throw refuse('bad_value', USAGE)
}

const USAGE =
  'a watch needs to: a session by name or id, "in 30m", "at 16:30" (this computer\'s time, the next such minute), "every 30m" (at least 10 minutes) or "#123" (a pull request\'s checks), and may take text, your note of at most 300 characters.'

function checkNote(note: string): void {
  if (note.length > WATCH.noteChars) throw refuse('too_long', `a watch's note is at most ${WATCH.noteChars} characters.`)
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** A slot's change key: its local minute, `2026-11-13T16:30` (§18.3) */
const slotKey = (ms: number) => {
  const d = new Date(ms)
  return `${day(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const CHANGE_TEXT: Record<SessionChange, string> = {
  turn_ended: 'its turn ended. Read what it said with read_session.',
  asked: 'it asked a question or for an approval. See it with read_session.',
  stopped: 'it stopped before its turn ended. See why with read_session.',
  gone: 'it is gone: in the session archive or deleted.',
}

export type WatchesHost = {
  hostId: string
  service: MessageService
  records: MailboxRecords
  now?: () => number
  /** A session of this host as a watch reads it, by address; undefined when it is not here (in the archive, deleted, never) */
  session(address: string): { working: boolean; cards: string[]; interrupted: boolean; held: boolean } | undefined
  /** Whether `reader` may read `target` with read_session: the one read rule (§18.3) */
  mayRead(reader: string, target: string): boolean
  /** Whether the address is a session on another computer */
  elsewhere(address: string): boolean
  /** Whether the address is a session of this host in the session archive, which may give it back */
  archived(address: string): boolean
  /** The project of a session of this host, by address */
  projectOf(address: string): string | null
  /** A pull request's checks in a project, asked of gh (`prChecks`, dev-services/git-pr.ts) */
  prChecks(project: string, number: number, signal?: AbortSignal): Promise<PrChecks | 'unavailable' | 'signed_out' | null>
}

/** Why gh cannot answer for a pull request watch, as a refusal and a watch's end say it */
const GH_MISSING = {
  unavailable: 'gh is not installed on this computer',
  signed_out: 'gh is not signed in on this computer (gh auth login)',
} as const

/**
 * The watches of this host (docs/plans/mailbox.md §18.5): `register`, `cancel`, `list`, `changed` from the mail hooks, and `due` from the one timer
 * and the delivery's sweep. Only a running delivery evaluates (`start` and `stop` come with it): a change while none runs is caught up at `start`.
 * Every firing is one transaction that re-reads the row, and its dedupe key makes a second evaluation post nothing
 */
export class Watches {
  private readonly now: () => number
  private readonly ulids = new UlidMaker()
  private readonly listeners = createListeners<string>((e) => console.error(`[mail] a watches listener failed: ${errorMessage(e)}`))
  private schedule: ((ms: number, fn: () => void) => () => void) | null = null
  private cancelTimer: (() => void) | null = null
  /** When the pull requests were last asked of gh, and whether an asking runs: one at a time, at most once a `WATCH.prPollMs` */
  private polledAt = -Infinity
  private polling = false
  /** For each pull request polled, its head and number of checks when the last poll found none running: a finish is believed when two polls agree */
  private settledAt = new Map<string, string>()

  constructor(private readonly host: WatchesHost) {
    this.now = host.now ?? Date.now
  }

  /** Hears the session (its id) whose watches changed: one was set, fired, ended or cancelled */
  onChange(listener: (owner: string) => void): () => void {
    return this.listeners.add(listener)
  }

  /** The delivery started: what changed while none ran fires once, then what is due, and the timer runs */
  start(schedule: (ms: number, fn: () => void) => () => void): void {
    this.schedule = schedule
    try {
      this.catchUp()
    } catch (e) {
      console.error(`[mail] catching up the watches failed: ${errorMessage(e)}`)
    }
    this.due()
  }

  stop(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.schedule = null
  }

  /** Sets a watch, or extends the same one (same owner, source and target) with this note; returns the answer the tool gives (§18.2) */
  register(owner: string, to: string, note: string, close: (id: string) => string): string {
    const now = this.now()
    const spec = isTimeWatch(to) ? timeSpec(to, now) : this.sessionSpec(owner, to)
    const { w, id } = this.put(owner, spec, spec.source === 'session' ? spec.target : to.trim(), note, close, now)
    if (spec.source === 'time') {
      return spec.kind === 'every'
        ? `Watching every ${spec.periodMin} minutes until ${this.clock(w.expiresAt)}, first at ${this.clock(spec.slotMs)}. ${id}`
        : `Watching for ${this.clock(spec.slotMs)}: Centralu wakes you then. ${id}`
    }
    const s = this.host.session(w.target)
    const doing = s?.cards.length ? 'it is waiting on a question or an approval now' : s?.working ? 'it is working now' : 'it is at rest now'
    return `Watching ${this.what(w)} until ${this.clock(w.expiresAt)}; ${doing}. ${id}`
  }

  /**
   * A watch on a pull request's checks (`#123`, §18.3), asked of gh first: gh missing or signed out, or a pull request it cannot read, is refused
   * and writes no row; one that has ended, or whose checks on its head have finished, has nothing to wait for
   */
  async registerPr(owner: string, number: number, note: string, close: (id: string) => string, signal?: AbortSignal): Promise<string> {
    checkNote(note)
    const project = this.host.projectOf(owner)
    if (!project) throw refuse('bad_value', 'a pull request is watched from a session in its project, and this session has none.')
    const r = await this.host.prChecks(project, number, signal)
    if (r === 'unavailable' || r === 'signed_out') throw refuse('unavailable', `${GH_MISSING[r]}, so Centralu cannot watch #${number} here.`)
    if (r === null) throw refuse('bad_value', `gh cannot read pull request #${number} in this session's project now.`)
    if (r.state !== 'open') return `#${number} is ${r.state} already: nothing to watch.`
    if (r.total > 0 && r.pending === 0) return `${checksEnded(number, r)} already: nothing to watch. A push starts new checks; watch again after it.`
    const { w, id } = this.put(owner, { source: 'pr', project, number, headOid: r.headOid }, `${project}#${number}`, note, close, this.now())
    return `Watching ${this.what(w)} until ${this.clock(w.expiresAt)}; ${r.pending} of ${r.total} still run. ${id}`
  }

  /** The row of a new watch, or the same one (owner, source, target) extended with this note (§18.2); refused past `WATCH.perSession` */
  private put(owner: string, spec: WatchSpec, target: string, note: string, close: (id: string) => string, now: number): { w: Watch; id: string } {
    checkNote(note)
    const active = this.list(owner)
    const same = active.find((w) => w.spec.source === spec.source && w.target === target)
    if (!same && active.length >= WATCH.perSession) {
      throw refuse('not_allowed', `a session keeps at most ${WATCH.perSession} watches. Cancel one with ${close('<id>')}.`)
    }
    const expiresAt = spec.source === 'time' && spec.kind !== 'every' ? spec.slotMs : now + WATCH.lastsMs
    const w: Watch = {
      ...(same ?? { id: watchIdOf(this.host.hostId, this.ulids.next(now)), owner, state: 'active', lastKey: null, firedCount: 0, createdAt: now, endedAt: null, endedBy: null }),
      target,
      spec,
      note,
      expiresAt,
      nextAt: spec.source === 'time' ? Math.min(spec.slotMs, expiresAt) : expiresAt,
    }
    this.host.records.saveWatch(writeWatch(w))
    this.emit(owner)
    return { w, id: `id ${w.id}. Cancel with ${close(w.id)}.` }
  }

  /**
   * Ends a watch (`by` its owner or the person), and takes back its firing not given yet: `cancelled` when it was active, `withdrawn` when it had ended
   * but its notice had not reached its owner, `ended` when there was nothing left to do (or no such watch)
   */
  cancel(id: string, by: 'owner' | 'person'): 'cancelled' | 'withdrawn' | 'ended' {
    const now = this.now()
    const done = this.host.records.transaction(() => {
      const w = this.read(id)
      if (!w) return undefined
      // Its firings: the quiet notice of its end (a cancel told before) stays
      const undelivered = this.host.records.undeliveredNotices('$.watch.id', id).filter(({ message }) => message.facts.quiet !== true)
      if (undelivered.length) this.host.records.deleteRows(undelivered.map(({ row }) => ({ messageId: row.messageId, recipient: row.recipient })))
      if (w.state !== 'active') return undelivered.length ? { w, how: 'withdrawn' as const } : undefined
      this.host.records.saveWatch(writeWatch({ ...w, state: 'cancelled', endedAt: now, endedBy: by, nextAt: null }))
      if (by === 'person') {
        this.host.service.notice(w.owner, { body: `The person cancelled your watch on ${this.what(w)}.`, facts: { quiet: true, watch: { id, source: w.spec.source, change: 'cancelled' } }, dedupeKey: this.key(w, 'cancelled') })
      }
      return { w, how: 'cancelled' as const }
    })
    if (!done) return 'ended'
    this.emit(done.w.owner)
    return done.how
  }

  /** A watch by id, active or ended, as this build reads it */
  read(id: string): Watch | undefined {
    const row = this.host.records.watch(id)
    return row && readWatch(row)
  }

  /** The owner's active watches, oldest first */
  list(owner: string): Watch[] {
    return this.host.records.activeWatches({ owner }).flatMap((r) => readWatch(r) ?? [])
  }

  /** The session's active watches as the person's window lists them (`watches.list`, §18.8) */
  views(sessionId: string): WatchView[] {
    return this.list(sessionAddress(this.host.hostId, sessionId)).map((w) => ({
      id: w.id,
      source: w.spec.source,
      what: w.spec.source === 'session' ? this.host.service.labelOf(w.spec.target) : w.spec.source === 'pr' ? `#${w.spec.number}` : '',
      at: w.spec.source === 'time' ? w.spec.slotMs : null,
      everyMinutes: w.spec.source === 'time' ? (w.spec.periodMin ?? null) : null,
      until: w.expiresAt,
      note: w.note,
      createdAt: w.createdAt,
    }))
  }

  /** What a watch waits for, in Centralu's words: `<name> (<address>)`, `a timer for 16:30`, `a timer every 30 minutes` */
  what(w: Watch): string {
    if (w.spec.source === 'session') return `${this.host.service.labelOf(w.spec.target)} (${w.spec.target})`
    if (w.spec.source === 'pr') return `the checks on #${w.spec.number}`
    return w.spec.kind === 'every' ? `a timer every ${w.spec.periodMin} minutes` : `a timer for ${this.clock(w.spec.slotMs)}`
  }

  /** A watched session changed (the mail hooks, §18.3): each active watch on it fires once, and ends. `card`: the request id a card was raised with */
  changed(target: string, change: SessionChange, card?: string): void {
    if (!this.schedule) return
    for (const row of this.host.records.activeWatches({ target })) {
      const w = readWatch(row)
      if (w?.spec.source !== 'session' || (card !== undefined && w.spec.baselineCards.includes(card))) continue
      // One watch that fails leaves the others, and the hook's own work after it, as they were
      try {
        this.fireSession(w, change)
      } catch (e) {
        console.error(`[mail] watch ${row.id}: ${errorMessage(e)}`)
      }
    }
  }

  /** Whether a session watch on `target` waits for its rest: a turn of it ended since the watch was set, and its own background work held the end (§18.3) */
  waitsForRest(target: string): boolean {
    const party = parseAddress(target)
    const ended = party?.kind === 'session' ? this.host.records.lastEndedTurn(party.sessionId) : 0
    return this.host.records.activeWatches({ target }).some((r) => {
      const w = readWatch(r)
      return w?.spec.source === 'session' && ended > w.spec.baselineTurn
    })
  }

  /**
   * A session left (the session archive or deleted): the watches on it fire `gone`. Its own stay, as its mail does, while the archive may give it back;
   * they are deleted with its mail when it is deleted for good (`MailboxRecords.purgeParty`, §18.4)
   */
  gone(address: string): void {
    this.changed(address, 'gone')
  }

  /**
   * A handoff moves `from`'s mailbox to `to` (`moveMail`: `MessageService.handOver`, scope `all`), in one transaction with this: its active watches
   * are `to`'s, the same rows, and the watches others keep on `from` wait for `to`, from `to`'s state now. One that would have `to` watch itself (the
   * original's on its heir, or the heir's on the original) ends, and nobody is told: no one set a watch on itself
   */
  handOver<T>(from: string, to: string, moveMail: () => T): T {
    const now = this.now()
    const owners = new Set([from, to])
    const moved = this.host.records.transaction(() => {
      for (const row of this.host.records.activeWatches({ owner: from })) this.host.records.saveWatch({ ...row, owner: to })
      for (const row of this.host.records.activeWatches({ target: from })) {
        const w = readWatch(row)
        if (w?.spec.source !== 'session') continue
        this.host.records.saveWatch(writeWatch({ ...w, spec: { ...w.spec, ...this.baseline(to), target: to } }))
        owners.add(w.owner)
      }
      for (const row of this.host.records.activeWatches({ owner: to })) {
        if (row.target === to) this.host.records.saveWatch({ ...row, state: 'cancelled', endedAt: now, endedBy: 'host', nextAt: null })
      }
      return moveMail()
    })
    for (const owner of owners) this.emit(owner)
    return moved
  }

  /** What is due by now fires (a time's slot) or ends (its 24 hours), then the timer is set to the next one. Also the delivery's sweep's safety net */
  due(now = this.now()): void {
    if (!this.schedule) return
    if (!this.polling && now - this.polledAt >= WATCH.prPollMs) void this.pollPrs(now)
    for (const row of this.host.records.activeWatches({ dueBy: now })) {
      const w = readWatch(row)
      try {
        if (w?.spec.source === 'time' && w.spec.slotMs <= now) this.fireTime(w, w.spec, now)
        else if (w && w.expiresAt <= now) this.expire(w, now)
      } catch (e) {
        console.error(`[mail] watch ${row.id}: ${errorMessage(e)}`)
      }
    }
    this.arm()
  }

  /** Every active session watch against its target's stored state (§18.5 catch-up): a change while no delivery ran fires once */
  private catchUp(): void {
    // An owner deleted for good by a build that does not know watches takes them with it, as `purgeParty` does
    for (const owner of new Set(this.host.records.activeWatches().map((r) => r.owner))) {
      if (!this.host.session(owner) && !this.host.archived(owner)) this.host.records.deleteWatchesOf(owner)
    }
    for (const row of this.host.records.activeWatches()) {
      const w = readWatch(row)
      if (w?.spec.source !== 'session') continue
      const s = this.host.session(w.spec.target)
      const party = parseAddress(w.spec.target)
      const baseline = w.spec.baselineCards
      const ended = party?.kind === 'session' && this.host.records.lastEndedTurn(party.sessionId) > w.spec.baselineTurn
      // A stop Centralu holds to continue is no change yet: its wait's end tells (`waitEnded`)
      const change: SessionChange | null = !s ? 'gone' : s.cards.some((c) => !baseline.includes(c)) ? 'asked' : ended && !s.working && !s.held ? (s.interrupted ? 'stopped' : 'turn_ended') : null
      if (change) this.fireSession(w, change)
    }
  }

  private fireSession(w: Watch, change: SessionChange): void {
    if (w.spec.source !== 'session') return
    const target = w.spec.target
    this.fire(w.id, change, (now) => ({
      body: `Your watch on ${this.what(w)}: ${CHANGE_TEXT[change]}`,
      facts: { watch: { id: w.id, source: 'session', change }, about: { session: target }, reason: change },
      next: { state: change === 'gone' ? 'gone' : 'fired', endedAt: now, endedBy: 'host', nextAt: null },
    }))
  }

  /**
   * A time's slot is due: the latest slot passed by now and not after the watch's end fires once (missed `every` slots are one firing), `late` when the
   * host was not there for the first slot missed
   */
  private fireTime(w: Watch, spec: Extract<WatchSpec, { source: 'time' }>, now: number): void {
    const period = (spec.periodMin ?? 0) * MINUTE_MS
    const last = Math.min(now, w.expiresAt)
    const slot = period > 0 ? spec.slotMs + Math.floor((last - spec.slotMs) / period) * period : spec.slotMs
    const late = now - spec.slotMs > MINUTE_MS
    const next = period > 0 ? slot + period : null
    const every = spec.kind === 'every' ? `, every ${spec.periodMin} minutes,` : ''
    this.fire(w.id, slotKey(slot), (at) => ({
      body: `Your timer set at ${this.clock(w.createdAt)}${every} for ${this.clock(slot)} is due.${late ? ` It fires late: Centralu was not running at ${this.clock(spec.slotMs)}, or the computer slept.` : ''}`,
      facts: { watch: { id: w.id, source: 'time', change: 'due', ...(late ? { late: true } : {}) } },
      next: next !== null && next <= w.expiresAt ? { spec: { ...spec, slotMs: next }, nextAt: next } : { state: next === null ? 'fired' : 'expired', endedAt: at, endedBy: 'host', nextAt: null },
    }))
  }

  /** It reached its end without a change: one quiet notice when it never fired (§18.4) */
  private expire(w: Watch, now: number): void {
    this.endQuietly(w.id, now, 'expired', (fresh) => (fresh.firedCount === 0 ? `Your watch on ${this.what(fresh)} ended after 24 hours without a change.` : null))
  }

  /** Ends an active watch by the host, with one quiet notice to its owner when `body` gives one */
  private endQuietly(id: string, now: number, change: string, body: (w: Watch) => string | null): void {
    const ended = this.host.records.transaction(() => {
      const fresh = this.read(id)
      if (fresh?.state !== 'active') return undefined
      this.host.records.saveWatch(writeWatch({ ...fresh, state: 'expired', endedAt: now, endedBy: 'host', nextAt: null }))
      const text = body(fresh)
      if (text !== null) {
        this.host.service.notice(fresh.owner, { body: text, facts: { quiet: true, watch: { id, source: fresh.spec.source, change } }, dedupeKey: this.key(fresh, change) })
      }
      return fresh
    })
    if (ended) this.emit(ended.owner)
  }

  /**
   * Asks gh once for each pull request an active watch names, however many name it (§18.3), and fires what ended: the checks on its head finished,
   * or none ran, as two polls in a row agree; or the pull request was merged or closed. A new head starts the wait again. gh gone or signed out ends
   * each watch with one quiet notice saying so; a gh that cannot answer now is asked again at the next poll
   */
  private async pollPrs(now: number): Promise<void> {
    this.polling = true
    this.polledAt = now
    try {
      const byPr = new Map<string, Watch[]>()
      for (const row of this.host.records.activeWatches()) {
        const w = readWatch(row)
        if (w?.spec.source === 'pr') byPr.set(w.target, [...(byPr.get(w.target) ?? []), w])
      }
      const settled = new Map<string, string>()
      for (const [target, watches] of byPr) {
        const first = watches[0]?.spec
        if (first?.source !== 'pr') continue
        const r = await this.host.prChecks(first.project, first.number).catch(() => null)
        if (!this.schedule || r === null) continue
        // A check can appear after the others ended, or a push's checks a moment after it: one more poll that sees the same is the finish
        const seen = typeof r === 'object' && r.pending === 0 ? `${r.headOid}:${r.total}` : null
        const agreed = seen !== null && this.settledAt.get(target) === seen
        if (seen !== null) settled.set(target, seen)
        for (const w of watches) this.prChanged(w, r, agreed)
      }
      this.settledAt = settled
    } catch (e) {
      console.error(`[mail] asking gh for the watched pull requests failed: ${errorMessage(e)}`)
    } finally {
      this.polling = false
    }
  }

  private prChanged(w: Watch, r: PrChecks | 'unavailable' | 'signed_out', agreed: boolean): void {
    if (w.spec.source !== 'pr') return
    const { number } = w.spec
    if (r === 'unavailable' || r === 'signed_out') {
      this.endQuietly(w.id, this.now(), 'gh', () => `Your watch on ${this.what(w)} ended: ${GH_MISSING[r]}.`)
      return
    }
    if (r.state !== 'open') {
      this.fire(w.id, r.state, (at) => ({ body: `Pull request #${number} was ${r.state}.`, facts: { watch: { id: w.id, source: 'pr', change: r.state } }, next: { state: 'fired', endedAt: at, endedBy: 'host', nextAt: null } }))
      return
    }
    if (r.headOid !== w.spec.headOid) this.moveHead(w.id, r.headOid)
    if (!agreed) return
    this.fire(w.id, `checks:${r.headOid}`, (at) => ({
      body: `${checksEnded(number, r)}.`,
      facts: { watch: { id: w.id, source: 'pr', change: 'checks' } },
      next: { state: 'fired', endedAt: at, endedBy: 'host', nextAt: null },
    }))
  }

  /** A push moved the pull request's head: the row, re-read in a transaction, waits for the new one if it is still active (gh was asked meanwhile) */
  private moveHead(id: string, headOid: string): void {
    this.host.records.transaction(() => {
      const fresh = this.read(id)
      if (fresh?.state === 'active' && fresh.spec.source === 'pr') this.host.records.saveWatch(writeWatch({ ...fresh, spec: { ...fresh.spec, headOid } }))
    })
  }

  /**
   * The firing (§18.5), one transaction: the row re-read and still active, its change not the last one fired; the notice to its owner, under a key
   * that makes a second evaluation (two hosts on one store, a sweep racing an event) post nothing; the row moved on or ended
   */
  private fire(id: string, change: string, make: (now: number) => { body: string; facts: Record<string, unknown>; next: Partial<Watch> }): void {
    const now = this.now()
    const w = this.host.records.transaction(() => {
      const w = this.read(id)
      if (w?.state !== 'active' || w.lastKey === change) return undefined
      const { body, facts, next } = make(now)
      const note = w.note ? `\n\nYour note:\n${quoted(w.note)}` : ''
      this.host.service.notice(w.owner, { body: body + note, facts, dedupeKey: this.key(w, change) })
      this.host.records.saveWatch(writeWatch({ ...w, lastKey: change, firedCount: w.firedCount + 1, ...next }))
      return w
    })
    if (!w) return
    this.warn(w.owner, now)
    this.emit(w.owner)
  }

  /** The person's warning when a session's watches woke it more than `warnWakesPerHour` times in the hour, counted from the store (§18.7) */
  private warn(owner: string, now: number): void {
    const n = this.host.records.watchFiringsSince(owner, now - HOUR_MS)
    if (n <= WATCH.warnWakesPerHour) return
    this.host.service.notice(PERSON, { body: WARNING_TEXT.watchWakes(this.host.service.labelOf(owner), n), facts: { watchWakes: { session: owner, count: n } }, dedupeKey: hourlyKey(`watchwakes:${owner}`, now) })
  }

  /** A session watch's target, refused as §18.3 says, and its baseline: the target's last ended turn and its cards now */
  private sessionSpec(owner: string, target: string): Extract<WatchSpec, { source: 'session' }> {
    const party = parseAddress(target)
    const me = parseAddress(owner)
    if (party?.kind !== 'session' || me?.kind !== 'session') throw refuse('bad_value', USAGE)
    if (target === owner) throw refuse('bad_value', 'a session does not watch itself.')
    if (this.host.elsewhere(target)) throw refuse('elsewhere', `${target} is on another computer, and a watch waits only for a session on this one.`)
    if (!this.host.session(target)) throw refuse('gone', `${target} is gone: it is in the session archive or deleted.`)
    if (!this.host.mayRead(owner, target)) throw refuse('not_allowed', `${target} is not a session you can read with read_session, so you cannot watch it.`)
    if (openTaskParties(this.host.records, target, 'to').includes(me.sessionId)) {
      throw refuse('not_allowed', `you gave ${this.host.service.labelOf(target)} work that is open: its last response or reply reaches you as mail, and so does its stop, without a watch.`)
    }
    return { source: 'session', target, ...this.baseline(target) }
  }

  private baseline(target: string): { baselineTurn: number; baselineCards: string[] } {
    const party = parseAddress(target)
    return { baselineTurn: party?.kind === 'session' ? this.host.records.lastEndedTurn(party.sessionId) : 0, baselineCards: this.host.session(target)?.cards ?? [] }
  }

  private key(w: Watch, change: string): string {
    return `watch:${w.owner}:${w.id}:${change}`
  }

  /** One timer, to the earliest active watch this build reads, through the delivery's `schedule` */
  private arm(): void {
    const schedule = this.schedule
    this.cancelTimer?.()
    this.cancelTimer = null
    if (!schedule) return
    const next = Math.min(...this.host.records.activeWatches().flatMap((r) => (readWatch(r) && r.nextAt !== null ? [r.nextAt] : [])))
    if (next === Infinity) return
    this.cancelTimer = schedule(Math.max(0, next - this.now()), () => {
      this.cancelTimer = null
      this.due()
    })
  }

  /** The owner's watch set changed: the window is told, and the timer follows */
  private emit(owner: string): void {
    const party = parseAddress(owner)
    if (party?.kind === 'session') this.listeners.emit(party.sessionId)
    this.arm()
  }

  /** A time as the session reads it: the host's local `16:30`, with the date when it is not today */
  clock(ms: number): string {
    const d = new Date(ms)
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    return day(d) === day(new Date(this.now())) ? hm : `${day(d)} ${hm}`
  }
}
