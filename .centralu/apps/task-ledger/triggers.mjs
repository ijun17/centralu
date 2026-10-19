// The four reasons the ledger tells the responsible session, as a function of what it holds and what it has heard of the
// sessions. Nothing here sends anything or remembers anything: the same input gives the same list, which is what makes a
// sweep find exactly what a live event found (docs/plans/task-ledger.md §4, §5).

/** The states in which a session is in a turn, as the host counts them (`isInTurn`): the turn has not ended */
const IN_TURN = new Set(['working', 'waiting_approval'])

/** What an item of attention is called, in the order the panel and the message list them */
export const KINDS = ['unblocked', 'unassigned', 'asking', 'answer', 'quiet']

/**
 * What needs the responsible session now.
 *
 * `responsibleId`: the session the ledger tells, whose own tasks are not watched (below).
 * `sessions`: Map of session id → the row last heard (`centralu.watchSessions`). `complete`: the map is a whole snapshot of
 * the project (not cut, and heard at least once), so a session missing from it is gone and not merely unheard.
 *
 * Each item: `{ key, kind, taskId, detail, also }`. `key` is the change that causes it (written down before it is sent, so
 * it is sent once); `also` are keys an item makes unnecessary, because it says the same (a task that just became ready is
 * also unassigned, and one message is enough).
 */
export function attention({ tasks, sessions, complete, now, quietMinutes, responsibleId = null }) {
  const items = []
  for (const t of tasks) {
    if (t.state === 'done') continue
    if (t.state === 'ready' && t.unblocked) {
      items.push({
        key: `unblocked:${t.id}:${t.unblocked.since}`,
        kind: 'unblocked',
        taskId: t.id,
        detail: t.assignee ? 'what blocked it is resolved' : 'what blocked it is resolved; nobody is assigned',
        also: [`unassigned:${t.id}:${t.stateSince}`],
      })
      continue
    }
    if (t.state === 'ready' && !t.assignee) {
      items.push({ key: `unassigned:${t.id}:${t.stateSince}`, kind: 'unassigned', taskId: t.id, detail: 'ready, nobody is assigned', also: [] })
      continue
    }
    if (t.state !== 'running' || !t.assignee) continue
    // The responsible session is told in its own conversation: each message makes it answer, and that answer would be a
    // new reason to tell it. Its own task is not watched
    if (t.assignee.sessionId === responsibleId) continue
    const row = sessions.get(t.assignee.sessionId)
    if (!row) {
      if (complete) {
        items.push({ key: `quiet:${t.id}:${t.assignee.sessionId}:gone`, kind: 'quiet', taskId: t.id, detail: 'its session no longer exists', also: [] })
      }
      continue
    }
    if (row.state === 'waiting_approval') {
      items.push({
        key: `asking:${t.id}:${row.id}:${row.waitingSince ?? 0}`,
        kind: 'asking',
        taskId: t.id,
        detail: row.pending?.questions > 0 ? 'its session stopped to ask a question' : 'its session stopped to ask for approval',
        also: [],
      })
      continue
    }
    if (!IN_TURN.has(row.state)) {
      if (t.seenSeq !== null && row.lastSeq > t.seenSeq) {
        const how = row.state === 'error' ? 'stopped with an error' : row.state === 'limited' ? 'stopped at a usage limit' : 'finished, with a new answer'
        items.push({ key: `answer:${t.id}:${row.id}:${row.lastSeq}`, kind: 'answer', taskId: t.id, detail: `its session ${how}`, also: [] })
      }
      continue
    }
    if (row.state === 'working' && now - row.activeAt > quietMinutes * 60_000) {
      const minutes = Math.round((now - row.activeAt) / 60_000)
      items.push({ key: `quiet:${t.id}:${row.id}:${row.lastSeq}`, kind: 'quiet', taskId: t.id, detail: `its session has been quiet for ${minutes} minutes`, also: [] })
    }
  }
  return items.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
}

/**
 * Which of a blocked task's blockers are resolved, from what GitHub says (`facts`: Maps of number → state) and which
 * stay open. A text blocker is resolved only by a person; a blocker GitHub has not answered for stays open.
 */
export function blockerStates(task, facts) {
  return task.blockedBy.map((b) => {
    if (b.kind === 'text') return { ...b, open: true, why: 'waiting on a person' }
    if (b.kind === 'issue') {
      const i = facts.issues.get(b.ref)
      if (!i) return { ...b, open: true, why: 'not read yet' }
      return i.state === 'closed' ? { ...b, open: false, why: 'closed' } : { ...b, open: true, why: 'open' }
    }
    if (b.kind === 'pr') {
      const p = facts.prs.get(b.ref)
      if (!p) return { ...b, open: true, why: 'not read yet' }
      if (p.state === 'merged') return { ...b, open: false, why: 'merged' }
      return { ...b, open: true, why: p.state === 'closed' ? 'closed without merging' : 'open' }
    }
    const d = facts.decisions.get(b.ref)
    if (d === undefined) return { ...b, open: true, why: 'not read yet' }
    return d ? { ...b, open: false, why: 'decided' } : { ...b, open: true, why: 'waiting for a decision' }
  })
}

/** A task is unblocked when it is blocked, has blockers, and none is open */
export function isUnblocked(task, facts) {
  return task.state === 'blocked' && task.blockedBy.length > 0 && blockerStates(task, facts).every((b) => !b.open)
}

/** One line of a title: no line breaks or control characters, cut. A title may come from an issue somebody else wrote */
export function titleLine(title, max = 80) {
  const clean = String(title).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The message the responsible session reads: at most `limit` items, then how many more */
export function composeMessage(project, items, titles, limit = 8) {
  const shown = items.slice(0, limit)
  const lines = shown.map((i) => `- ${i.taskId} ${JSON.stringify(titleLine(titles.get(i.taskId) ?? ''))}: ${i.detail}.`)
  if (items.length > shown.length) lines.push(`- and ${items.length - shown.length} more: call ledger_list to see them.`)
  const head = items.length === 1 ? 'Task ledger: one thing needs you.' : `Task ledger: ${items.length} things need you.`
  return `${head}${project ? ` (${project})` : ''}\n${lines.join('\n')}\nCall ledger_list for the tasks, and ledger_update to assign a task, change its state, or mark it seen.`
}
