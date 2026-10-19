// The ledger's data and the rules that change it, as plain functions: no files, no clock of their own, no Centralu.
// docs/plans/task-ledger.md §1 says what a task is and why it is shaped so.

export const STATES = ['ready', 'running', 'review', 'queued', 'blocked', 'done']
export const BLOCKER_KINDS = ['issue', 'pr', 'decision', 'text']

export const LIMITS = {
  title: 200,
  next: 300,
  notes: 4000,
  blockers: 5,
  blockerText: 200,
  tasks: 500,
  addresses: 50,
  label: 40,
}

/** A finished task is kept this long, so "done" can be undone, then it goes */
export const DONE_KEEP_MS = 14 * 24 * 60 * 60 * 1000
export const VERSION = 1

export function defaultSettings() {
  return {
    /** The one session the ledger tells: { sessionId, address, label } or null */
    responsible: null,
    quietMinutes: 30,
    sweepMinutes: 10,
    github: { on: false, repo: null },
  }
}

export function emptyLedger() {
  return { version: VERSION, newer: false, nextId: 1, settings: defaultSettings(), tasks: [], notified: {}, addresses: {} }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '')
const oneLine = (v, max) => str(v, max * 4).replace(/\s+/g, ' ').trim().slice(0, max)
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function cleanBlocker(b) {
  if (!isObj(b) || !BLOCKER_KINDS.includes(b.kind)) return null
  if (b.kind === 'text') {
    const text = oneLine(b.text, LIMITS.blockerText)
    return text ? { kind: 'text', ref: null, text } : null
  }
  const ref = Number(b.ref)
  if (!Number.isInteger(ref) || ref <= 0) return null
  return { kind: b.kind, ref, text: oneLine(b.text, LIMITS.blockerText) }
}

function cleanBlockers(list) {
  if (!Array.isArray(list)) return []
  return list.map(cleanBlocker).filter(Boolean).slice(0, LIMITS.blockers)
}

function cleanAssignee(a) {
  if (!isObj(a) || typeof a.sessionId !== 'string' || !a.sessionId) return null
  return { sessionId: a.sessionId, name: oneLine(a.name, 80) || a.sessionId.slice(0, 8) }
}

/**
 * A task as read from the file: what this build knows is made to fit, what it does not know is kept and written back
 * (a later build's field survives a rollback to this one).
 */
export function cleanTask(raw, now) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null
  const title = oneLine(raw.title, LIMITS.title)
  if (!title) return null
  return {
    ...raw,
    id: raw.id,
    title,
    state: STATES.includes(raw.state) ? raw.state : 'ready',
    stateSince: num(raw.stateSince, now),
    blockedBy: cleanBlockers(raw.blockedBy),
    next: oneLine(raw.next, LIMITS.next),
    notes: str(raw.notes, LIMITS.notes),
    issue: Number.isInteger(raw.issue) && raw.issue > 0 ? raw.issue : null,
    assignee: cleanAssignee(raw.assignee),
    // The assignee's last message number when somebody last looked; null: take the first one seen as the starting point
    seenSeq: raw.seenSeq === null || raw.seenSeq === undefined ? null : num(raw.seenSeq, null),
    // Set when the last blocker resolved and nobody has acted on it yet: { since } names that change
    unblocked: isObj(raw.unblocked) && typeof raw.unblocked.since === 'number' ? { since: raw.unblocked.since } : null,
    createdAt: num(raw.createdAt, now),
    updatedAt: num(raw.updatedAt, now),
    doneAt: raw.state === 'done' ? num(raw.doneAt, now) : null,
  }
}

function cleanSettings(raw) {
  const d = defaultSettings()
  if (!isObj(raw)) return d
  const resp = raw.responsible
  return {
    ...raw,
    responsible:
      isObj(resp) && typeof resp.sessionId === 'string' && typeof resp.address === 'string'
        ? { sessionId: resp.sessionId, address: resp.address, label: oneLine(resp.label, LIMITS.label) }
        : null,
    quietMinutes: clamp(num(raw.quietMinutes, d.quietMinutes), 1, 24 * 60),
    sweepMinutes: clamp(num(raw.sweepMinutes, d.sweepMinutes), 1, 24 * 60),
    github: {
      on: isObj(raw.github) && raw.github.on === true,
      repo: isObj(raw.github) && typeof raw.github.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(raw.github.repo) ? raw.github.repo : null,
    },
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)))

/** The file's content made to fit this build, or an empty ledger when it is not one */
export function normalize(raw, now) {
  if (!isObj(raw)) return emptyLedger()
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => cleanTask(t, now)).filter(Boolean)
  const highest = tasks.reduce((n, t) => Math.max(n, Number(/^T(\d+)$/.exec(t.id)?.[1] ?? 0)), 0)
  const notified = {}
  if (isObj(raw.notified)) {
    for (const [k, v] of Object.entries(raw.notified)) {
      if (isObj(v) && typeof v.at === 'number') notified[k] = v
    }
  }
  const addresses = {}
  if (isObj(raw.addresses)) {
    for (const [k, v] of Object.entries(raw.addresses)) {
      if (isObj(v) && typeof v.address === 'string') addresses[k] = { address: v.address, label: oneLine(v.label, LIMITS.label), at: num(v.at, now) }
    }
  }
  // A file a later build wrote is read as far as it can be and never written back (a rollback must not turn its states and
  // fields into this build's): `newer` is not part of the file
  const newer = typeof raw.version === 'number' && raw.version > VERSION
  return {
    ...raw,
    version: newer ? raw.version : VERSION,
    newer,
    // Never below an id already used: an id is not reused
    nextId: Math.max(Math.floor(num(raw.nextId, 1)), highest + 1),
    settings: cleanSettings(raw.settings),
    tasks,
    notified,
    addresses,
  }
}

export function findTask(ledger, id) {
  const wanted = String(id ?? '').trim().replace(/^#/, '')
  return ledger.tasks.find((t) => t.id.toLowerCase() === wanted.toLowerCase())
}

/** Adds a task. Answers `{ task }` or `{ error }`. */
export function addTask(ledger, input, now) {
  const title = oneLine(input.title, LIMITS.title)
  if (!title) return { error: 'A task needs a title.' }
  if (ledger.tasks.filter((t) => t.state !== 'done').length >= LIMITS.tasks) return { error: `The ledger holds ${LIMITS.tasks} open tasks; finish or remove some first.` }
  if (input.state !== undefined && !STATES.includes(input.state)) return { error: `A state is one of ${STATES.join(', ')}.` }
  if (input.issue != null && ledger.tasks.some((t) => t.issue === input.issue)) {
    return { error: `Issue #${input.issue} is already task ${ledger.tasks.find((t) => t.issue === input.issue).id}.` }
  }
  const state = input.state ?? (Array.isArray(input.blockedBy) && input.blockedBy.length ? 'blocked' : 'ready')
  const task = cleanTask(
    {
      id: `T${ledger.nextId}`,
      title,
      state,
      stateSince: now,
      blockedBy: input.blockedBy,
      next: input.next,
      notes: input.notes,
      issue: input.issue ?? null,
      assignee: input.assignee ?? null,
      seenSeq: null,
      unblocked: null,
      createdAt: now,
      updatedAt: now,
    },
    now,
  )
  if (task.assignee && task.state === 'ready') task.state = 'running'
  ledger.nextId += 1
  ledger.tasks.push(task)
  return { task }
}

/**
 * Changes a task. `patch` may hold title, state, next, notes, issue, blockedBy, assignee ({ sessionId, name } or null).
 * Whoever changes a task has looked at it: a pending "unblocked" is cleared, and `seenNow` (the assignee's last message
 * number, when the engine knows it) becomes what was seen. Answers `{ task, changed }` or `{ error }`.
 */
export function updateTask(ledger, id, patch, now, { seenNow = null } = {}) {
  const original = findTask(ledger, id)
  if (!original) return { error: `There is no task ${id}.` }
  // Changed on a copy: a patch that is refused halfway leaves the task as it was
  const before = JSON.stringify(original)
  const task = structuredClone(original)
  if (patch.title !== undefined) {
    const title = oneLine(patch.title, LIMITS.title)
    if (!title) return { error: 'A task needs a title.' }
    task.title = title
  }
  if (patch.next !== undefined) task.next = oneLine(patch.next, LIMITS.next)
  if (patch.notes !== undefined) task.notes = str(patch.notes, LIMITS.notes)
  if (patch.issue !== undefined) {
    if (patch.issue !== null && (!Number.isInteger(patch.issue) || patch.issue <= 0)) return { error: 'An issue is a number, or null to unlink.' }
    const other = patch.issue === null ? undefined : ledger.tasks.find((t) => t.issue === patch.issue && t !== original)
    if (other) return { error: `Issue #${patch.issue} is already task ${other.id}.` }
    if (patch.issue !== task.issue) task.issueSeen = null
    task.issue = patch.issue
  }
  if (patch.blockedBy !== undefined) {
    if (!Array.isArray(patch.blockedBy)) return { error: 'blockedBy is a list.' }
    const clean = cleanBlockers(patch.blockedBy)
    if (clean.length !== Math.min(patch.blockedBy.length, LIMITS.blockers)) return { error: 'A blocker is an issue, pr or decision with a number, or text with words.' }
    task.blockedBy = clean
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee !== null && !cleanAssignee(patch.assignee)) return { error: 'An assignee is a session id, or null.' }
    const next = patch.assignee === null ? null : cleanAssignee(patch.assignee)
    if ((next?.sessionId ?? null) !== (task.assignee?.sessionId ?? null)) task.seenSeq = null
    task.assignee = next
    // Giving a ready task to a session starts it; taking the session off a running one does not stop it
    if (next && task.state === 'ready' && patch.state === undefined) setState(task, 'running', now)
  }
  if (patch.state !== undefined) {
    if (!STATES.includes(patch.state)) return { error: `A state is one of ${STATES.join(', ')}.` }
    if (patch.state !== task.state) setState(task, patch.state, now)
  }
  task.unblocked = null
  if (seenNow !== null && task.assignee && task.seenSeq !== null && seenNow > task.seenSeq) task.seenSeq = seenNow
  const changed = JSON.stringify(task) !== before
  task.updatedAt = now
  ledger.tasks[ledger.tasks.indexOf(original)] = task
  return { task, changed }
}

export function setState(task, state, now) {
  task.state = state
  task.stateSince = now
  task.doneAt = state === 'done' ? now : null
  task.unblocked = null
}

export function removeTask(ledger, id) {
  const task = findTask(ledger, id)
  if (!task) return { error: `There is no task ${id}.` }
  ledger.tasks = ledger.tasks.filter((t) => t !== task)
  return { task }
}

/** Tasks that were done long enough ago go; answers how many */
export function dropOldDone(ledger, now) {
  const before = ledger.tasks.length
  ledger.tasks = ledger.tasks.filter((t) => t.state !== 'done' || now - (t.doneAt ?? now) < DONE_KEEP_MS)
  return before - ledger.tasks.length
}

export function updateSettings(ledger, patch) {
  const s = ledger.settings
  if (patch.quietMinutes !== undefined) {
    if (!Number.isFinite(patch.quietMinutes)) return { error: 'quietMinutes is a number of minutes.' }
    s.quietMinutes = clamp(patch.quietMinutes, 1, 24 * 60)
  }
  if (patch.sweepMinutes !== undefined) {
    if (!Number.isFinite(patch.sweepMinutes)) return { error: 'sweepMinutes is a number of minutes.' }
    s.sweepMinutes = clamp(patch.sweepMinutes, 1, 24 * 60)
  }
  if (patch.github !== undefined) {
    if (!isObj(patch.github)) return { error: 'github is { on, repo }.' }
    if (patch.github.on !== undefined) s.github.on = patch.github.on === true
    if (patch.github.repo !== undefined) {
      if (patch.github.repo !== null && !/^[\w.-]+\/[\w.-]+$/.test(String(patch.github.repo))) return { error: 'A repository is owner/name.' }
      s.github.repo = patch.github.repo
    }
  }
  if (patch.responsible === null) s.responsible = null
  return { settings: s }
}

/** Keeps the address a session called with, so the person can make it responsible later (the oldest go past `LIMITS.addresses`) */
export function noteAddress(ledger, sessionId, address, label, now) {
  const old = ledger.addresses[sessionId]
  ledger.addresses[sessionId] = { address, label: oneLine(label, LIMITS.label) || old?.label || '', at: now }
  const all = Object.entries(ledger.addresses)
  if (all.length > LIMITS.addresses) {
    for (const [k] of all.sort((a, b) => a[1].at - b[1].at).slice(0, all.length - LIMITS.addresses)) delete ledger.addresses[k]
  }
}

/** The session id inside an address Centralu gave (`<session id>.<mac>`) */
export function sessionOfAddress(address) {
  if (typeof address !== 'string') return null
  const dot = address.lastIndexOf('.')
  return dot > 0 ? address.slice(0, dot) : null
}
