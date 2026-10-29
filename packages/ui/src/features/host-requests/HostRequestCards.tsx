import { useEffect, useState } from 'react'
import { useStore } from '../../store/store.js'
import { Pill } from '../../components/Pill.jsx'

/** How long a card stands before its buttons take a click: the next card must not take a click meant for the last */
export const HOST_REQUEST_ARM_MS = 500

/**
 * A program's call waiting for the person (#1405). Something on this computer that is not this window (an agent's
 * script, a tool) holds only the limited credential, and asked for something that cannot be undone or that widens what
 * runs without asking. The host holds the call; this card is the only way it runs.
 *
 * It stands over the lanes rather than in their flow: it comes and goes on a program's schedule, and taking room would
 * move what the person is reading (the reason the global approval banner went, product-spec.md). It has no keys, unlike
 * a session's card: a y meant for the composer must never delete something for good. One card at a time, oldest first,
 * with how many more wait. A card's buttons take a click only once it has stood `HOST_REQUEST_ARM_MS`, and one click:
 * the next card appears where this one was, and a program that hears the answer can ask again at once.
 */
export function HostRequestCards() {
  const requests = useStore((s) => s.hostRequests)
  const first = requests[0]
  const id = first?.requestId ?? null
  /** The card whose buttons take a click now: none until it has stood a moment, none again once answered */
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    setArmed(null)
    if (id === null) return
    const t = setTimeout(() => setArmed(id), HOST_REQUEST_ARM_MS)
    return () => clearTimeout(t)
  }, [id])
  if (!first) return null
  const more = requests.length - 1
  const live = armed === first.requestId
  const answer = (decision: 'allow' | 'deny') => {
    if (!live) return
    setArmed(null)
    void useStore.getState().answerHostRequest(first.requestId, decision)
  }
  return (
    <div
      className="absolute left-1/2 top-3 z-30 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 shadow-(--shadow-popover)"
      role="alertdialog"
      aria-label="A program asks for your approval"
      data-testid="host-request-card"
      data-method={first.method}
      data-armed={live ? 'true' : 'false'}
    >
      <div className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised">
        <div className="flex items-center gap-2 px-3 pt-3">
          <Pill size="label" edge="solid" tone="bright">
            Awaiting approval
          </Pill>
          <span className="text-xs text-ink-faint" data-testid="host-request-from">
            A program on this computer{first.client ? ` (it calls itself ${first.client})` : ''}
            {first.session ? `, which says it runs under the session ${first.session},` : ''} asks, and waits
          </span>
        </div>
        {/* All of it shows, wrapped anywhere: what runs is what the card says, and a long line of JSON has no spaces */}
        <p
          className="mt-2 max-h-[50vh] overflow-y-auto whitespace-pre-wrap px-3 text-md leading-body text-ink [overflow-wrap:anywhere]"
          data-testid="host-request-detail"
        >
          {first.question}
        </p>
        <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
          It came from outside this window, so it runs only if you allow it. If you did not ask for this, deny it.
        </p>
        <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
          <button className={BUTTON} onClick={() => answer('allow')} disabled={!live} data-testid="host-request-allow">
            Allow
          </button>
          <button className={BUTTON} onClick={() => answer('deny')} disabled={!live} data-testid="host-request-deny">
            Deny
          </button>
          {more > 0 && (
            <span className="ml-auto text-xs text-ink-faint" data-testid="host-request-more">
              {more === 1 ? '1 more waits' : `${more} more wait`}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const BUTTON = 'rounded-md px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50'
