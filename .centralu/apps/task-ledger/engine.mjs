// The ledger: its data, what it has heard of the sessions, the sweep, and the one message to the responsible session.
// Everything it needs from outside comes in as a function (`deps`), so the tests drive it with a clock and a recording
// notifier, and `server.mjs` drives it with Centralu's. docs/plans/task-ledger.md says why it works this way.
import { addTask, dropOldDone, emptyLedger, findTask, noteAddress, normalize, removeTask, sessionOfAddress, updateSettings, updateTask } from './model.mjs'
import { attention, blockerStates, composeMessage, isUnblocked, titleLine } from './triggers.mjs'

/** Notifications due within this long of each other go in one message */
export const BATCH_MS = 15_000
/** The responsible session is told at most once in this long (Centralu itself allows 10 a minute) */
export const MIN_GAP_MS = 60_000
/** A message Centralu refused is tried again at the next sweep, this many times, then shown as not delivered */
export const MAX_ATTEMPTS = 3
/** What was told stays on record this long after it stopped being true, so a flicker is not told twice */
const KEEP_NOTIFIED_MS = 24 * 60 * 60 * 1000

const emptyFacts = () => ({ issues: new Map(), prs: new Map(), decisions: new Map() })

export class Ledger {
  /**
   * deps: load() → the file's content; save(data); notify(address, text) → true once Centralu took it; readFacts(args) →
   * `github.mjs` `readFacts`; busy(reason | false); now(); schedule(fn, ms) → cancel; project: the name shown in messages
   */
  constructor(deps) {
    this.deps = deps
    this.ledger = emptyLedger()
    /** Session id → the row last heard */
    this.sessions = new Map()
    /** The map holds the whole project (heard in full, not cut), so a session missing from it is gone */
    this.complete = false
    this.observing = { ok: false, reason: 'not heard yet', at: null }
    this.github = { ok: null, error: null, at: null, open: [] }
    this.facts = emptyFacts()
    this.lastSentAt = 0
    this.cancelBatch = null
    this.chain = Promise.resolve()
  }

  now() {
    return this.deps.now()
  }

  async start() {
    const now = this.now()
    this.ledger = normalize(await this.deps.load(), now)
    // A message that was being sent when the app stopped may have gone: it is not sent a second time
    for (const n of Object.values(this.ledger.notified)) if (n.status === 'sending') n.status = 'sent'
    this.syncBusy()
  }

  /** One change at a time: every public method that changes the ledger goes through here */
  serial(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async persist() {
    if (this.ledger.newer) return
    const { newer: _newer, ...file } = this.ledger
    await this.deps.save(file)
  }

  /** Runs `fn(ledger)`, saves, and looks at what is due. `fn` answers a result; an `{ error }` result saves nothing */
  mutate(fn) {
    return this.serial(async () => {
      if (this.ledger.newer) return { error: 'This ledger was written by a newer version of the app, so this one only reads it. Update the app, or move ledger.json aside to start again.' }
      const result = fn(this.ledger)
      if (result?.error) return result
      this.adoptSeen()
      await this.persist()
      this.afterChange()
      return result
    })
  }

  // ---- the sessions ----

  /** The answer of a poll: every session of the project (`full`), or the ones that changed and the ids that went */
  applyObservation({ full, sessions, gone, truncated }) {
    return this.serial(async () => {
      if (full) this.sessions = new Map()
      for (const row of sessions) this.sessions.set(row.id, row)
      for (const id of gone ?? []) this.sessions.delete(id)
      if (full) this.complete = !truncated
      this.observing = { ok: true, reason: null, at: this.now() }
      const changed = this.adoptSeen()
      if (changed) await this.persist()
      this.afterChange()
    })
  }

  /** The poll failed (an older Centralu, a restart): said on the panel; what was heard stays */
  observationFailed(reason) {
    this.observing = { ok: false, reason, at: this.observing.at }
  }

  /**
   * An assignee heard for the first time becomes the starting point: its earlier messages are not "a new answer". Also
   * keeps the name a gone session had. Answers whether the ledger changed.
   */
  adoptSeen() {
    let changed = false
    for (const t of this.ledger.tasks) {
      const row = t.assignee && this.sessions.get(t.assignee.sessionId)
      if (!row) continue
      if (t.seenSeq === null) {
        t.seenSeq = row.lastSeq
        changed = true
      }
      if (row.name && row.name !== t.assignee.name) {
        t.assignee.name = row.name.slice(0, 80)
        changed = true
      }
    }
    return changed
  }

  /** The assignee's last message number now, for a task someone just looked at */
  seenNow(task) {
    const id = this.ledger.tasks.find((t) => t.id === task)?.assignee?.sessionId
    return (id && this.sessions.get(id)?.lastSeq) ?? null
  }

  // ---- what needs attention, and what was told ----

  items() {
    return attention({ tasks: this.ledger.tasks, sessions: this.sessions, complete: this.complete, now: this.now(), quietMinutes: this.ledger.settings.quietMinutes, responsibleId: this.ledger.settings.responsible?.sessionId ?? null })
  }

  /** The items nobody has been told of yet (and may be told now) */
  due() {
    const now = this.now()
    const items = this.items()
    const covered = new Set(items.flatMap((i) => i.also))
    return items.filter((i) => {
      if (covered.has(i.key)) return false
      const n = this.ledger.notified[i.key]
      if (!n) return true
      return n.status === 'pending' && n.nextAt <= now
    })
  }

  afterChange() {
    this.syncBusy()
    if (this.cancelBatch || !this.ledger.settings.responsible || !this.due().length) return
    const wait = Math.max(BATCH_MS, this.lastSentAt + MIN_GAP_MS - this.now())
    this.cancelBatch = this.deps.schedule(() => {
      this.cancelBatch = null
      void this.flush().catch((e) => console.error(`[task-ledger] telling the responsible session failed: ${e?.message ?? e}`))
    }, wait)
  }

  /** Keeps the app running while there is anything to watch (the person sees why on its row, and can stop it) */
  syncBusy() {
    const open = this.ledger.tasks.filter((t) => t.state !== 'done').length
    this.deps.busy(open ? `watching ${open} task${open === 1 ? '' : 's'}` : false)
  }

  /**
   * Tells the responsible session what is due, in one message. Each item's key is written down before the message goes,
   * so a crash in between costs a message, never a repeat. Answers what happened.
   */
  flush({ force = false } = {}) {
    return this.serial(async () => {
      const resp = this.ledger.settings.responsible
      if (!resp) return { sent: 0, why: 'nobody is responsible' }
      const items = this.due()
      if (!items.length) return { sent: 0, why: 'nothing is due' }
      const now = this.now()
      if (!force && now - this.lastSentAt < MIN_GAP_MS) {
        this.afterChange()
        return { sent: 0, why: 'told a moment ago' }
      }
      const marks = this.ledger.notified
      for (const i of items) {
        const before = marks[i.key]
        marks[i.key] = { at: now, status: 'sending', attempts: before?.attempts ?? 0, kind: i.kind, taskId: i.taskId }
        for (const k of i.also) marks[k] ??= { at: now, status: 'sent', attempts: 0, kind: 'unassigned', taskId: i.taskId }
      }
      await this.persist()
      const titles = new Map(this.ledger.tasks.map((t) => [t.id, t.title]))
      let taken = false
      try {
        taken = (await this.deps.notify(resp.address, composeMessage(this.deps.project, items, titles))) === true
      } catch {
        taken = false
      }
      const after = this.now()
      for (const i of items) {
        const m = marks[i.key]
        if (taken) {
          m.status = 'sent'
          m.at = after
        } else {
          m.attempts += 1
          m.status = m.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
          m.nextAt = after + this.ledger.settings.sweepMinutes * 60_000
        }
      }
      if (taken) this.lastSentAt = after
      await this.persist()
      return taken ? { sent: items.length } : { sent: 0, why: 'Centralu did not take the message' }
    })
  }

  // ---- GitHub and the sweep ----

  /**
   * Reads GitHub, moves what it settles, forgets what is old, and tells what is due. GitHub is read *outside* the chain
   * of changes: `gh` may take a minute, and a tool call must not wait that long to add a task.
   */
  async sweep() {
    const refs = await this.serial(async () => this.refsToRead())
    const s = this.ledger.settings
    const read = await this.deps.readFacts({ repo: s.github.repo, deciders: s.github.deciders, ...refs, wantOpen: s.github.on })
    return this.serial(async () => {
      const now = this.now()
      if (read.ok) {
        this.facts = read.facts
        this.github = { ok: true, error: null, at: now, open: this.ledger.settings.github.on ? read.open : [] }
        this.applyFacts(now)
      } else {
        this.github = { ...this.github, ok: false, error: read.error, at: now }
      }
      dropOldDone(this.ledger, now)
      this.prune(now)
      this.adoptSeen()
      await this.persist()
      this.afterChange()
      return { ok: read.ok, error: read.ok ? null : read.error }
    })
  }

  /** The issues, pull requests and decisions the tasks refer to now */
  refsToRead() {
    const refs = { issues: new Set(), prs: new Set(), decisions: new Set() }
    // Off, GitHub is not asked at all: a project without it never sees it (docs/plans/task-ledger.md §2)
    if (!this.ledger.settings.github.on) return refs
    for (const t of this.ledger.tasks) {
      if (t.state === 'done' && !t.issueClosed) continue
      if (t.issue) refs.issues.add(t.issue)
      if (t.state === 'blocked') {
        for (const b of t.blockedBy) {
          if (b.kind === 'issue') refs.issues.add(b.ref)
          else if (b.kind === 'pr') refs.prs.add(b.ref)
          else if (b.kind === 'decision') refs.decisions.add(b.ref)
        }
      }
    }
    return refs
  }

  /** What GitHub says settles: a linked issue's title and whether it is closed, and blockers that are resolved */
  applyFacts(now) {
    for (const t of this.ledger.tasks) {
      const issue = t.issue ? this.facts.issues.get(t.issue) : null
      if (issue) {
        if (issue.title) t.title = titleLine(issue.title, 200)
        // Only when the issue changes: a person who reopens the task while its issue is still closed is not overruled
        const was = t.issueSeen ?? null
        t.issueSeen = issue.state
        if (issue.state === 'closed' && was !== 'closed' && t.state !== 'done') {
          t.state = 'done'
          t.stateSince = now
          t.doneAt = now
          t.issueClosed = true
          t.unblocked = null
        } else if (issue.state === 'open' && t.state === 'done' && t.issueClosed) {
          // The issue was reopened: the task it closed is ready again
          t.state = 'ready'
          t.stateSince = now
          t.doneAt = null
          t.issueClosed = false
        }
      }
      if (isUnblocked(t, this.facts)) {
        t.state = 'ready'
        t.stateSince = now
        t.unblocked = { since: now }
        t.updatedAt = now
      }
    }
  }

  prune(now) {
    // What a session's state caused is forgotten only when the sessions are known: a sweep that runs before the first
    // answer of the poll sees none, and would take every old key for one that stopped being true (a restart a day after
    // a message would tell it again)
    if (!this.complete) return
    const live = new Set(this.items().flatMap((i) => [i.key, ...i.also]))
    for (const [key, n] of Object.entries(this.ledger.notified)) {
      if (live.has(key)) continue
      if (now - n.at > KEEP_NOTIFIED_MS) delete this.ledger.notified[key]
    }
  }

  // ---- what the tools and the panel do ----

  add(input) {
    return this.mutate((l) => addTask(l, input, this.now()))
  }

  update(id, patch) {
    return this.mutate((l) => {
      const seenNow = this.seenNow(id)
      return updateTask(l, id, patch, this.now(), { seenNow })
    })
  }

  remove(id) {
    return this.mutate((l) => removeTask(l, id))
  }

  settings(patch) {
    return this.mutate((l) => updateSettings(l, patch))
  }

  /** A session called a tool: its address is kept, so the person can make it the responsible one */
  hearAddress(address, label) {
    const sessionId = sessionOfAddress(address)
    if (!sessionId) return Promise.resolve()
    const known = this.ledger.addresses[sessionId]
    // Saved when it is new or its name came, not on every call it makes
    if (known && known.address === address && (!label || known.label === label)) return Promise.resolve()
    return this.mutate((l) => {
      noteAddress(l, sessionId, address, label, this.now())
      if (l.settings.responsible?.sessionId === sessionId) l.settings.responsible.address = address
    })
  }

  /** The session behind `address` becomes the one the ledger tells */
  takeCharge(address, label) {
    const sessionId = sessionOfAddress(address)
    if (!sessionId) return Promise.resolve({ error: 'Only a session can take charge: call this from a session, not from the panel.' })
    return this.mutate((l) => {
      noteAddress(l, sessionId, address, label, this.now())
      l.settings.responsible = { sessionId, address, label: l.addresses[sessionId].label }
      return { responsible: l.settings.responsible }
    })
  }

  /** The person picks one of the sessions that has called the ledger */
  chooseResponsible(sessionId) {
    return this.mutate((l) => {
      const known = l.addresses[sessionId]
      if (!known) return { error: 'That session has not used the ledger yet; it can take charge itself with ledger_take_charge.' }
      l.settings.responsible = { sessionId, address: known.address, label: known.label }
      return { responsible: l.settings.responsible }
    })
  }

  /** Adds a task for each issue the panel offers */
  adopt(numbers) {
    return this.mutate((l) => {
      const added = []
      for (const n of numbers) {
        const found = this.github.open.find((o) => o.number === n)
        if (!found) continue
        const r = addTask(l, { title: titleLine(found.title, 200), issue: n }, this.now())
        if (r.task) added.push(r.task.id)
      }
      return { added }
    })
  }

  /** The panel's whole state: what the person sees and edits */
  view() {
    const l = this.ledger
    const items = this.items()
    const byTask = new Map()
    for (const i of items) byTask.set(i.taskId, [...(byTask.get(i.taskId) ?? []), i])
    const linked = new Set(l.tasks.map((t) => t.issue).filter(Boolean))
    const tasks = l.tasks.map((t) => {
      const row = t.assignee ? this.sessions.get(t.assignee.sessionId) : null
      return {
        ...t,
        blockers: blockerStates(t, this.facts),
        assigneeState: row ? { state: row.state, live: row.live, activeAt: row.activeAt, pending: row.pending } : null,
        attention: (byTask.get(t.id) ?? []).map((i) => ({ kind: i.kind, detail: i.detail, told: l.notified[i.key]?.status ?? null })),
      }
    })
    const failed = Object.values(l.notified).filter((n) => n.status === 'failed').length
    const responsible = l.settings.responsible
    return {
      project: this.deps.project,
      readOnly: l.newer === true,
      now: this.now(),
      tasks,
      attention: items.map((i) => ({ taskId: i.taskId, kind: i.kind, detail: i.detail, told: l.notified[i.key]?.status ?? null })),
      responsible: responsible ? { sessionId: responsible.sessionId, label: responsible.label } : null,
      choices: Object.entries(l.addresses).map(([sessionId, a]) => ({ sessionId, label: a.label || this.sessions.get(sessionId)?.name || sessionId.slice(0, 8) })),
      sessions: [...this.sessions.values()].filter((s) => s.appId === null).map((s) => ({ id: s.id, name: s.name, state: s.state, kind: s.kind })),
      observing: this.observing,
      github: { on: l.settings.github.on, repo: l.settings.github.repo, deciders: l.settings.github.deciders, ok: this.github.ok, error: this.github.error, at: this.github.at, offers: this.github.open.filter((o) => !linked.has(o.number)) },
      settings: { quietMinutes: l.settings.quietMinutes, sweepMinutes: l.settings.sweepMinutes },
      failedTold: failed,
    }
  }

  get(id) {
    return findTask(this.ledger, id)
  }
}
