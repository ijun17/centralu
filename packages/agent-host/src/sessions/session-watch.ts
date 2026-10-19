import { randomBytes } from 'node:crypto'
import { isInTurn, type NormalizedEvent, type SessionInfo } from '@cc/protocol'
import type { ObservedSession, SessionsAnswer } from '../apps/external/runtime.js'

/**
 * What an app that declares `uses.sessions: ["observe"]` hears of its project's sessions (docs/apps.md §10,
 * docs/plans/task-ledger.md): a log of which session changed, and a long-poll on it.
 *
 * It keeps no copy of any session. Each event the host sends is turned into a small fingerprint of what an app may
 * see; when the fingerprint of the session it belongs to changed, the change takes the next revision and goes into a
 * ring. A poll answers with the sessions that changed after the revision it holds, read fresh from the manager. A
 * poll that holds nothing usable (no cursor, the cursor of another host, or older than the ring) is answered with
 * every session of the project and `full: true`: that is the only recovery there is, and it covers an app that was
 * stopped, a host swap and a ring that overflowed alike.
 */

/** Changes kept: a poll further behind than this gets the whole project instead */
export const WATCH_RING = 1000
/** Sessions in one answer: a project with more is cut to its newest, and the answer says so */
export const WATCH_ROWS_MAX = 500

export type SessionWatchDeps = {
  /** A session as the manager holds it now, or undefined (not here, or in the trash) */
  get(sessionId: string): SessionInfo | undefined
  /** Every session the manager holds: read only for a full answer */
  all(): SessionInfo[]
  /** Whether the session has a live process */
  live(sessionId: string): boolean
  /** A session being moved to the trash is no longer there for an app */
  leaving(sessionId: string): boolean
  now?: () => number
  /** How long an answer waits after the first change, so a burst is one answer */
  settleMs?: number
}

/** One change in the feed: which session, in which project (null: none), at which revision */
export type SessionChange = { rev: number; id: string; projectId: string | null }
type Change = SessionChange

export class SessionWatch {
  /** Names this host among others: a cursor from another one is not followed */
  readonly epoch = randomBytes(4).toString('hex')
  private rev = 0
  private ring: Change[] = []
  private prints = new Map<string, { print: string; projectId: string | null }>()
  private activeAt = new Map<string, number>()
  private listeners = new Set<(c: SessionChange) => void>()
  private readonly startedAt: number

  constructor(private readonly deps: SessionWatchDeps) {
    this.startedAt = (deps.now ?? Date.now)()
  }

  /** Every event the host sends passes here, after it went out */
  observe(e: NormalizedEvent): void {
    const id = e.sessionId
    if (!id) return
    if (e.type === 'session_deleted') {
      this.activeAt.delete(id)
      const had = this.prints.get(id)
      if (had) {
        this.prints.delete(id)
        this.note(id, had.projectId)
      }
      return
    }
    const s = this.deps.get(id)
    if (!s || this.deps.leaving(id)) return
    // Titles and moves are not the session doing anything. Only a session that is here is kept: a late event for one that
    // went would otherwise leave an entry nothing removes
    if (e.type !== 'session_title' && e.type !== 'session_created' && e.type !== 'session_live' && e.type !== 'session_owner') {
      this.activeAt.set(id, (this.deps.now ?? Date.now)())
    }
    const print = this.print(s)
    const had = this.prints.get(id)
    if (had && had.print === print) return
    this.prints.set(id, { print, projectId: s.projectId })
    // A session moved into a project (a user-folder app's builder and agents, when it becomes a project): the project it
    // left hears that it went, the one it joined that it is there
    if (had && had.projectId !== s.projectId) this.note(id, had.projectId)
    this.note(id, s.projectId)
  }

  /**
   * What an app may see change. `lastSeq` only counts while the session is at rest: during a turn it moves with every
   * message, and a poll that woke on each would never rest. At rest it is the "a new answer is there" mark, and the
   * host stores it, so it is true after a restart too.
   */
  private print(s: SessionInfo): string {
    return [
      s.projectId ?? '',
      s.name,
      s.kind,
      s.state,
      this.deps.live(s.id) ? 1 : 0,
      s.pendingApproval ? 1 : 0,
      s.pendingQuestions.length,
      s.parentSessionId ?? '',
      s.askedBy ?? '',
      isInTurn(s.state) ? '' : s.lastSeq,
    ].join('\u0001')
  }

  private note(id: string, projectId: string | null): void {
    this.rev += 1
    this.ring.push({ rev: this.rev, id, projectId })
    if (this.ring.length > WATCH_RING) this.ring.splice(0, this.ring.length - WATCH_RING)
    const change = this.ring[this.ring.length - 1]!
    for (const fn of [...this.listeners]) fn(change)
  }

  /**
   * The feed itself: `fn` is called, right after the event that caused it, with each change to what an app may see of a
   * session. A poll for an app is one reader of it (`watch`); a watch the host keeps for a session (#1324) is meant to be
   * another, on the same source and the same fingerprint, so the two cannot disagree about what changed. Returns the way
   * to stop listening. A listener must not throw and must not wait: it runs inside the event's path.
   */
  onChange(fn: (c: SessionChange) => void): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private cursor(): string {
    return `${this.epoch}.${this.rev}`
  }

  /** The revision a cursor names, when this host can still answer from it; null otherwise */
  private revisionOf(cursor: string | undefined): number | null {
    if (!cursor) return null
    const dot = cursor.lastIndexOf('.')
    if (dot <= 0 || cursor.slice(0, dot) !== this.epoch) return null
    const n = Number(cursor.slice(dot + 1))
    if (!Number.isInteger(n) || n < 0 || n > this.rev) return null
    return this.followable(n) ? n : null
  }

  /** Every change after `n` is still in the ring: the change before the oldest one kept is not newer than `n` */
  private followable(n: number): boolean {
    const oldest = this.ring[0]?.rev ?? this.rev + 1
    return n >= oldest - 1
  }

  private row(s: SessionInfo): ObservedSession {
    // Once an app has been shown a session, its deletion is a change to tell (it could not be told of one never shown)
    if (this.prints.get(s.id)?.projectId !== s.projectId) this.prints.set(s.id, { print: this.print(s), projectId: s.projectId })
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      tool: s.tool,
      state: s.state,
      live: this.deps.live(s.id),
      waitingSince: s.waitingSince,
      lastSeq: s.lastSeq,
      activeAt: this.activeAt.get(s.id) ?? this.startedAt,
      parentId: s.parentSessionId,
      askedBy: s.askedBy ?? null,
      pending: { approvals: s.pendingApproval ? 1 : 0, questions: s.pendingQuestions.length },
      createdAt: s.createdAt,
      machine: s.machine ?? null,
      appId: s.appId,
    }
  }

  /** Every session of the project: what an app compares with what it remembers */
  private full(projectId: string): SessionsAnswer {
    const mine = this.deps
      .all()
      .filter((s) => s.projectId === projectId && !this.deps.leaving(s.id))
      .sort((a, b) => b.createdAt - a.createdAt)
    const cut = mine.length > WATCH_ROWS_MAX
    return { cursor: this.cursor(), full: true, sessions: mine.slice(0, WATCH_ROWS_MAX).map((s) => this.row(s)), gone: [], ...(cut ? { truncated: true } : {}) }
  }

  private since(projectId: string, after: number): SessionsAnswer {
    const ids = new Set<string>()
    for (const c of this.ring) if (c.rev > after && c.projectId === projectId) ids.add(c.id)
    const sessions: ObservedSession[] = []
    const gone: string[] = []
    for (const id of ids) {
      const s = this.deps.get(id)
      if (s && s.projectId === projectId && !this.deps.leaving(id)) sessions.push(this.row(s))
      else gone.push(id)
    }
    return { cursor: this.cursor(), full: false, sessions, gone }
  }

  private pending(projectId: string, after: number): boolean {
    return this.ring.some((c) => c.rev > after && c.projectId === projectId)
  }

  /**
   * One poll for a project: right away when the cursor is not usable or something changed after it, else when
   * something does, else empty after `waitMs`. An aborted poll answers empty at once.
   */
  async watch(projectId: string, cursor: string | undefined, waitMs: number, signal: AbortSignal): Promise<SessionsAnswer> {
    const after = this.revisionOf(cursor)
    if (after === null) return this.full(projectId)
    if (!this.pending(projectId, after) && waitMs > 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          off()
          signal.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        const off = this.onChange((c) => {
          if (c.projectId === projectId) done()
        })
        signal.addEventListener('abort', done, { once: true })
      })
      // A burst is one answer: let the rest of it land
      if (!signal.aborted && this.pending(projectId, after)) await new Promise((r) => setTimeout(r, this.deps.settleMs ?? 250))
      // The ring may have gone past the cursor while the poll waited (other projects' changes): then it is a full answer
      if (!this.followable(after)) return this.full(projectId)
    }
    return this.since(projectId, after)
  }
}
