import { centraluCallLabel, centraluCallTitle, type ToolSummary } from '@cc/protocol'
import { useStore, type ChatItem } from '../../../store/store.js'
import { AppIcon, CentraluMarkIcon, ChevronIcon } from '../../../components/icons.jsx'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * The session a Centralu call names (#730): the one in its arguments (`sessionId`), else the first `[id]` its answer
 * names that this window knows (start_agent's "the codex session "…" [id]"). Only a session the window has, so the
 * link never opens nothing.
 */
function useNamedSession(item: ToolItem, call: NonNullable<ToolSummary['centralu']>, selfId: string) {
  return useStore((s) => {
    const ids = [call.sessionId, ...[...(item.result?.matchAll(/\[([^\]\s]+)\]/g) ?? [])].map((m) => m[1])]
    const id = ids.find((x) => x && x !== selfId && s.sessions[x])
    return id ? s.sessions[id] : undefined
  })
}

/**
 * The title row of a call to Centralu's own tools (#730): the Centralu mark (an app's window icon and name for an app's
 * tool) and what the call did in words, where an ordinary card shows the raw tool name; the argument the call is
 * followed by; and the way to the session it names. The person most wants to follow these calls: they are where an
 * agent reaches other sessions, projects, machines or apps. The rest of the card (output, folding) is the ordinary
 * card's.
 */
export function CentraluCallHeader({
  item,
  call,
  sessionId,
  open,
  onToggle,
}: {
  item: ToolItem
  /** The session this card is in: a call naming it gets no link to where the person already is */
  sessionId: string
  call: NonNullable<ToolSummary['centralu']>
  open: boolean
  onToggle: () => void
}) {
  const appName = useStore((s) => (call.app ? (s.externalApps.find((a) => a.appId === call.app)?.name ?? undefined) : undefined))
  const label = centraluCallLabel(call, appName)
  const title = centraluCallTitle(item, call)
  const named = useNamedSession(item, call, sessionId)
  const focus = useStore((s) => s.focusSession)
  return (
    <div className="flex w-full items-center">
      <button
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-2 text-left"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="tool-card-toggle"
      >
        <span className="shrink-0 text-ink-faint">
          <ChevronIcon open={open} />
        </span>
        <span className="shrink-0 text-ink-muted" data-testid="centralu-call-mark" data-mark={call.app ? 'app' : 'centralu'}>
          {call.app ? <AppIcon size={12} /> : <CentraluMarkIcon size={12} />}
        </span>
        <span className="shrink-0 text-xs text-ink-muted" data-testid="centralu-call-label">
          {label}
        </span>
        {title && (
          <span className="min-w-0 truncate text-xs text-ink-faint" data-testid="tool-card-title">
            {title}
          </span>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-2 px-2.5">
        {named && (
          <button
            type="button"
            className="text-xs text-ink-faint hover:text-ink"
            onClick={() => focus(named.id)}
            data-testid="centralu-call-open"
            title={named.name}
          >
            Open session →
          </button>
        )}
        {item.ok === false && <span className="text-xs text-ink">Failed</span>}
      </div>
    </div>
  )
}
