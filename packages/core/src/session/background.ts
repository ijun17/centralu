import { liveBackgroundTasks, type BackgroundTask } from '@cc/protocol'

const tasks = (n: number) => `${n} background task${n === 1 ? '' : 's'}`

/**
 * What pressing Stop on the turn does to the session's background work (#290), as one line for the Stop control —
 * null when nothing is running in the background.
 *
 * On 2026-10-04 an interrupt stopped two background subagents and nothing said so; one had finished its work and
 * stopped just before committing. Each task carries what an interrupt does to it as measured for its tool
 * (`stopsWithTurn`): Claude stops a subagent and leaves a shell running, Codex leaves a child agent running. A task
 * whose tool was not measured is not promised either way — "may keep running" is the honest middle, and it leans
 * towards the person checking rather than assuming the work is safe or gone.
 */
export function interruptNotice(all: readonly BackgroundTask[]): string | null {
  const live = liveBackgroundTasks(all)
  if (live.length === 0) return null
  const stops = live.filter((t) => t.stopsWithTurn === true).length
  const keeps = live.filter((t) => t.stopsWithTurn === false).length
  const unknown = live.length - stops - keeps
  const parts: string[] = []
  if (stops > 0) parts.push(`also stops ${tasks(stops)}`)
  if (keeps > 0) parts.push(`${tasks(keeps)} ${keeps === 1 ? 'keeps' : 'keep'} running`)
  if (unknown > 0) parts.push(`${tasks(unknown)} may keep running`)
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** The number the header, the sidebar and the control rail show — running tasks that are activity (ambient excluded). */
export function backgroundCount(all: readonly BackgroundTask[]): number {
  return liveBackgroundTasks(all).length
}
