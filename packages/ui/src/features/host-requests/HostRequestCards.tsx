import { useStore } from '../../store/store.js'
import { Pill } from '../../components/Pill.jsx'

/**
 * A program's call waiting for the person (#1405). Something on this computer that is not this window (an agent's
 * script, a tool) holds only the limited credential, and asked for something that cannot be undone or that widens what
 * runs without asking. The host holds the call; this card is the only way it runs.
 *
 * It stands over the lanes rather than in their flow: it comes and goes on a program's schedule, and taking room would
 * move what the person is reading (the reason the global approval banner went, product-spec.md). It has no keys, unlike
 * a session's card: a y meant for the composer must never delete something for good. One card at a time, oldest first,
 * with how many more wait.
 */
export function HostRequestCards() {
  const requests = useStore((s) => s.hostRequests)
  const first = requests[0]
  if (!first) return null
  const more = requests.length - 1
  return (
    <div
      className="absolute left-1/2 top-3 z-30 w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 shadow-(--shadow-popover)"
      role="alertdialog"
      aria-label="A program asks for your approval"
      data-testid="host-request-card"
      data-method={first.method}
    >
      <div className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised">
        <div className="flex items-center gap-2 px-3 pt-3">
          <Pill size="label" edge="solid" tone="bright">
            Awaiting approval
          </Pill>
          <span className="text-xs text-ink-faint" data-testid="host-request-from">
            A program on this computer{first.client ? ` (it calls itself ${first.client})` : ''} asks, and waits
          </span>
        </div>
        <p className="mt-2 whitespace-pre-wrap px-3 text-md leading-body text-ink" data-testid="host-request-detail">
          {first.question}
        </p>
        <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
          It came from outside this window, so it runs only if you allow it. If you did not ask for this, deny it.
        </p>
        <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
          <button className={BUTTON} onClick={() => void useStore.getState().answerHostRequest(first.requestId, 'allow')} data-testid="host-request-allow">
            Allow
          </button>
          <button className={BUTTON} onClick={() => void useStore.getState().answerHostRequest(first.requestId, 'deny')} data-testid="host-request-deny">
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

const BUTTON = 'rounded-md px-2 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink'
