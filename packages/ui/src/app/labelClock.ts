/** A label supplies the delay until its next displayed value changes, or null once it is static. */
export type NextLabelTick = (now: number) => number | null

type Label = { next: NextLabelTick; tick: (now: number) => void; due: number | null }

/** One timeout for all mounted time labels. Only labels whose deadline passed are repainted. */
export class LabelClock {
  private readonly labels = new Set<Label>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private visible = false

  subscribe(next: NextLabelTick, tick: (now: number) => void): () => void {
    const now = Date.now()
    const label: Label = { next, tick, due: this.deadline(next, now) }
    this.labels.add(label)
    tick(now)
    this.schedule()
    return () => {
      this.labels.delete(label)
      this.schedule()
    }
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (visible) {
      const now = Date.now()
      for (const label of this.labels) {
        label.due = this.deadline(label.next, now)
        label.tick(now)
      }
    }
    this.schedule()
  }

  private deadline(next: NextLabelTick, now: number): number | null {
    const delay = next(now)
    // Read just past a boundary so rounding never leaves the old number on screen.
    return delay === null ? null : now + Math.max(1, delay) + 5
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.visible) return
    let due = Infinity
    for (const label of this.labels) if (label.due !== null) due = Math.min(due, label.due)
    if (!Number.isFinite(due)) return
    this.timer = setTimeout(() => {
      this.timer = null
      const now = Date.now()
      for (const label of this.labels) {
        if (label.due === null || label.due > now) continue
        label.due = this.deadline(label.next, now)
        label.tick(now)
      }
      this.schedule()
    }, Math.max(1, due - Date.now()))
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** A label changes at whole steps from its timestamp, regardless of the wall-clock phase. */
export function nextAgeTick(when: number, now: number): number {
  const elapsed = Math.max(0, now - when)
  const step = elapsed < HOUR ? MINUTE : HOUR
  return step - elapsed % step
}

export function nextWaitingTick(since: number, now: number): number {
  const elapsed = Math.max(0, now - since)
  const step = elapsed < MINUTE ? 1000 : elapsed < DAY ? MINUTE : HOUR
  return step - elapsed % step
}

export function nextResetTick(at: number, now: number): number | null {
  if (!Number.isFinite(at) || at <= now) return null
  const step = at - now > DAY ? HOUR : MINUTE
  const remaining = at - now
  // A floor-based countdown drops immediately after an exact boundary.
  return Math.min(remaining % step || 1, remaining)
}

export function formatAgo(when: number, now: number): string {
  const min = Math.floor((now - when) / MINUTE)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`
}

/** Visible windows keep advancing even when another app has focus (for example, on a second monitor). */
export function watchLabelVisibility(
  clock: LabelClock,
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
): () => void {
  const refresh = () => clock.setVisible(doc.visibilityState === 'visible')
  doc.addEventListener('visibilitychange', refresh)
  refresh()
  return () => {
    doc.removeEventListener('visibilitychange', refresh)
    clock.setVisible(false)
  }
}
