import { useMemo } from 'react'
import { centraluCallLabel, centraluCallTitle, type ToolSummary } from '@cc/protocol'
import { useStore, type ChatItem } from '../../../store/store.js'
import { AppIcon, CentraluMarkIcon, ChevronIcon } from '../../../components/icons.jsx'

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * The calls whose answer names the one session they made or reached as its first `[id]` (start_agent's "the codex
 * session "…" [id]"). Any other answer may name many (list_sessions, agent_session list, recall's hits): its first id
 * is an arbitrary session, so only the one its arguments name is linked (#730 review).
 */
const ANSWER_NAMES_ITS_SESSION: ReadonlySet<string> = new Set(['start_agent', 'ask_project', 'create_session'])

/**
 * The session a Centralu call names (#730): the one in its arguments (`sessionId`), else, for the calls above, the
 * first `[id]` its answer names. Only a session the window has (a deleted one gets no link), never the one it is in.
 * The answer is read once per answer, not on every store update.
 */
function useNamedSession(item: ToolItem, call: NonNullable<ToolSummary['centralu']>, selfId: string) {
  const fromAnswer = useMemo(
    () => (ANSWER_NAMES_ITS_SESSION.has(call.tool) ? (item.result?.match(/\[([^\]\s]+)\]/)?.[1] ?? null) : null),
    [call.tool, item.result],
  )
  return useStore((s) => {
    const id = [call.sessionId, fromAnswer].find((x) => x && x !== selfId && s.sessions[x])
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
  const running = item.result === undefined && item.ok === undefined
  return (
    <div className="flex w-full items-center gap-2 py-2 pl-2.5 pr-2">
      <button
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="tool-card-toggle"
      >
        {/* The mark on its own small tile: Centralu's, or the app's window for an app's tool */}
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-hover/60 text-ink"
          data-testid="centralu-call-mark"
          data-mark={call.app ? 'app' : 'centralu'}
        >
          {call.app ? <AppIcon size={13} /> : <CentraluMarkIcon size={13} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="shrink-0 text-sm font-medium text-ink" data-testid="centralu-call-label">
              {label}
            </span>
            {running && <span className="readout shrink-0 text-2xs text-ink-faint" data-testid="centralu-call-running">running…</span>}
            {item.ok === false && <span className="shrink-0 text-2xs text-ink-muted" data-testid="centralu-call-failed">failed</span>}
          </span>
          {title && (
            <span className="mt-0.5 block truncate text-xs text-ink-muted" data-testid="tool-card-title">
              {title}
            </span>
          )}
        </span>
      </button>
      {named && (
        /* The session it reached, as a chip that opens it: where the person most wants to go from here */
        <button
          type="button"
          className="flex h-6 max-w-[200px] shrink-0 items-center gap-1 rounded-full border border-line bg-surface-hover/30 px-2.5 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          onClick={() => focus(named.id)}
          data-testid="centralu-call-open"
          title={`Open ${named.name}`}
        >
          <span className="truncate">{named.name}</span>
          <span aria-hidden>→</span>
        </button>
      )}
      <button
        type="button"
        className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:text-ink"
        onClick={onToggle}
        aria-label={open ? 'Hide the answer' : 'Show the answer'}
        tabIndex={-1}
      >
        <ChevronIcon open={open} />
      </button>
    </div>
  )
}
