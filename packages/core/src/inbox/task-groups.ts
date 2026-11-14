import type { MailTaskRow } from '@cc/protocol/client'

/**
 * The Inbox's Tasks (#1577, owner 2026-11-14): the host's open work grouped by who acts next. Pure, so the page the list moves to when it outgrows the
 * Inbox groups it the same way. The host words each row's state (`MailTaskRow.state`); this only sorts the words into groups:
 *
 * - Needs you: a question to the person not answered yet, a request held for the person to say what happens to it (`held`), and the person's task
 *   reported back and not closed (`review`);
 * - Waiting on others: what another party has, open or running. A state word this build does not know (a future `queued`) waits here too;
 * - Unassigned: what nobody is on any more (`released`: a stop released it, or its assignee is gone);
 * - Done: settled, folded on screen.
 *
 * Each group is newest first; in Needs you the questions come first, then what is held, then the reviews, as the Waiting list puts what asks the person
 * on top (#2213).
 */
export type TaskGroups = { needsYou: MailTaskRow[]; waitingOnOthers: MailTaskRow[]; unassigned: MailTaskRow[]; done: MailTaskRow[] }

/** Where a row goes, by the host's state word and who has it */
function groupOf(t: Pick<MailTaskRow, 'state' | 'assignee'>): keyof TaskGroups {
  if (t.state === 'done') return 'done'
  if (t.state === 'review' || t.state === 'held') return 'needsYou'
  if (t.state === 'released') return 'unassigned'
  return t.assignee.kind === 'person' ? 'needsYou' : 'waitingOnOthers'
}

/** Needs you's order: a question to the person, then what is held for them, then a review */
const needsYouRank = (t: MailTaskRow): number => (t.state === 'review' ? 2 : t.state === 'held' ? 1 : 0)

export function groupTasks(tasks: readonly MailTaskRow[]): TaskGroups {
  const groups: TaskGroups = { needsYou: [], waitingOnOthers: [], unassigned: [], done: [] }
  const newest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const t of newest) groups[groupOf(t)].push(t)
  // A stable sort: each part stays newest first
  groups.needsYou.sort((a, b) => needsYouRank(a) - needsYouRank(b))
  return groups
}

/** The rows a list of the groups shows, in the order it draws them: Done only while it is unfolded */
export function shownTasks(g: TaskGroups, doneOpen: boolean): MailTaskRow[] {
  return [...g.needsYou, ...g.waitingOnOthers, ...g.unassigned, ...(doneOpen ? g.done : [])]
}

/** How many tasks are not done: what the Tasks switch counts */
export const openTaskCount = (g: TaskGroups): number => g.needsYou.length + g.waitingOnOthers.length + g.unassigned.length

/** What names a task row: a message has one row per recipient */
export const taskKey = (t: Pick<MailTaskRow, 'id' | 'assignee'>): string => `${t.id}:${t.assignee.address}`
