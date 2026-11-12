import { useRef, useState } from 'react'
import type { SessionSummary } from '@cc/core'
import { DotsIcon } from '../../components/icons.jsx'
import { RowMenu } from '../sidebar/menus/RowMenu.jsx'
import { AskedByRow } from './chat-rows/delegation.jsx'

/**
 * The header's ⋯ menu (owner, 2026-11-12, #2213): what a session's header has to offer that is not worth a badge on every
 * session. Today the way back to the session that asked for this one (#371), which was a badge beside the name. Drawn only
 * when it has a row, so a session nobody asked has no empty menu.
 *
 * A plain button, not an IconButton, as the project's own ⋯ is: pressing it opens a named menu right there, so a hover tooltip
 * would be noise left overlapping the open menu. The screen-reader name stays.
 */
export function SessionHeaderMenu({ session }: { session: SessionSummary }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  if (!session.askedBy) return null
  return (
    <span ref={anchor} className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="session-more"
        className={`flex items-center justify-center rounded-md p-1 transition-colors hover:bg-surface-hover/60 hover:text-ink ${open ? 'text-ink' : 'text-ink-faint'}`}
      >
        <DotsIcon />
      </button>
      {open && (
        <RowMenu anchorEl={anchor.current} testId="session-more-menu" onClose={() => setOpen(false)} className="w-64">
          <AskedByRow callerId={session.askedBy} projectId={session.projectId ?? null} onDone={() => setOpen(false)} />
        </RowMenu>
      )}
    </span>
  )
}
