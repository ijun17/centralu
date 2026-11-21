import type { MailTaskRow } from '@cc/protocol/client'

/**
 * The Inbox's Tasks grouped by who acts next (#1577). The host words each row's state; a word this build does not know
 * waits in Waiting on others. Each group is newest first; Needs you puts questions, then held, then reviews (#2213).
 */
export type TaskGroups = { needsYou: MailTaskRow[]; waitingOnOthers: MailTaskRow[]; unassigned: MailTaskRow[]; done: MailTaskRow[] }

function groupOf(t: Pick<MailTaskRow, 'state' | 'assignee'>): keyof TaskGroups {
  if (t.state === 'done') return 'done'
  if (t.state === 'review' || t.state === 'held') return 'needsYou'
  if (t.state === 'released') return 'unassigned'
  return t.assignee.kind === 'person' ? 'needsYou' : 'waitingOnOthers'
}

const needsYouRank = (t: MailTaskRow): number => (t.state === 'review' ? 2 : t.state === 'held' ? 1 : 0)

export function groupTasks(tasks: readonly MailTaskRow[]): TaskGroups {
  const groups: TaskGroups = { needsYou: [], waitingOnOthers: [], unassigned: [], done: [] }
  const newest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const t of newest) groups[groupOf(t)].push(t)
  // Stable: each part stays newest first
  groups.needsYou.sort((a, b) => needsYouRank(a) - needsYouRank(b))
  return groups
}

export function shownTasks(g: TaskGroups, doneOpen: boolean): MailTaskRow[] {
  return [...g.needsYou, ...g.waitingOnOthers, ...g.unassigned, ...(doneOpen ? g.done : [])]
}

export const openTaskCount = (g: TaskGroups): number => g.needsYou.length + g.waitingOnOthers.length + g.unassigned.length

/** A message has one row per recipient */
export const taskKey = (t: Pick<MailTaskRow, 'id' | 'assignee'>): string => `${t.id}:${t.assignee.address}`
