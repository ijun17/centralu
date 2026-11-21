import { useEffect, useState } from 'react'
import { LEAVE_MS } from '../../components/presence.js'
import { rowKeyOf, type WaitingRow } from './inboxList.js'

/** What the list draws for a row: its place in the list the keys walk, or null for a card on its way out */
export type ShownRow = { row: WaitingRow; place: number | null }

type Ghost = { row: WaitingRow; at: number }

const isCard = (r: WaitingRow) => r.kind === 'mail' && r.thread.ask !== null

/**
 * The list's rows, with the cards that just left kept for their exit (#2229): an answered card fades out in place for
 * `LEAVE_MS` (design-system §9). A ghost has no place in the cursor's list, so it takes no press or key. Decided while
 * rendering, like `usePresence`, so the card keeps its state (the pick it shows) and does not blink.
 */
export function useLeavingCards(rows: readonly WaitingRow[]): ShownRow[] {
  // The rows are a new array on every render (`arrangeInbox` over a moving clock), so a change is a change of keys:
  // comparing by identity would set state on every render pass and never settle
  const keys = JSON.stringify(rows.map(rowKeyOf))
  const [before, setBefore] = useState({ keys, rows })
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  if (before.keys !== keys) {
    setBefore({ keys, rows })
    const now = new Set(rows.map(rowKeyOf))
    const gone = before.rows.flatMap((row, at) => (isCard(row) && !now.has(rowKeyOf(row)) ? [{ row, at }] : []))
    // A card that came back is no longer on its way out
    const stay = ghosts.filter((g) => !now.has(rowKeyOf(g.row)))
    if (gone.length > 0 || stay.length !== ghosts.length) setGhosts([...stay, ...gone])
  }
  useEffect(() => {
    if (ghosts.length === 0) return
    const t = setTimeout(() => setGhosts([]), LEAVE_MS)
    return () => clearTimeout(t)
  }, [ghosts])
  const shown: ShownRow[] = rows.map((row, place) => ({ row, place }))
  for (const g of [...ghosts].sort((a, b) => a.at - b.at)) shown.splice(Math.min(g.at, shown.length), 0, { row: g.row, place: null })
  return shown
}
