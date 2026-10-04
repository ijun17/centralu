import { useEffect } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { letterOf } from '../../app/keys.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * Approval card (FR-3). Keyboard first — y/n/a, ⌥a scopes it to the project.
 * A GUI slower than the mouse is worse than a terminal.
 * Color is used only on the left rail: tinting the whole card would make the command itself
 * unreadable.
 */
export function ApprovalCard({
  sessionId,
  requestId,
  detail,
}: {
  sessionId: string
  requestId: string
  detail: ApprovalDetail
}) {
  const respond = useStore((s) => s.respondApproval)
  // The buttons cannot be clicked while a response is in flight — a second response would record an executed command as denied (#158)
  const busy = useStore((s) => !!s.approvalsInFlight[requestId])
  const sc = useShortcut()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable,
        // Ignored if the card is behind another screen or **is not the card of the focused session** —
        // when several cards are up in the grid, a single y must not approve all of them
        covered: approvalCardCovered(st, sessionId),
      })
      if (!action) return
      // A capability question (M4 D-4) has no "always allow" — the answer gets remembered either way. `a` does nothing on this card
      if (detail.kind === 'capability' && action.decision === 'always') return
      // The "always allow" toast is shown using the matcher the store sent back (#170)
      void respond(sessionId, requestId, action.decision, action.scope)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, respond])

  if (detail.kind === 'capability') {
    return (
      <PermissionCard
        appName={detail.app.name}
        text={detail.text}
        onAnswer={(decision) => void respond(sessionId, requestId, decision)}
      />
    )
  }

  return (
    <div
      className="overflow-hidden rounded border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-[10px] font-medium">
          Awaiting approval
        </span>
        <span className="text-[11px] text-ink-faint">Agent is blocked, waiting</span>
      </div>

      <pre
        className="mt-2 whitespace-pre-wrap break-words px-3 font-mono text-[12px] leading-relaxed text-ink"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k="y" label="Allow" onClick={() => void respond(sessionId, requestId, 'allow')} testId="approve-allow" disabled={busy} />
        <ActionKey k="n" label="Deny" onClick={() => void respond(sessionId, requestId, 'deny')} testId="approve-deny" disabled={busy} />
        <ActionKey
          k="a"
          label="Always allow"
          testId="approve-always"
          disabled={busy}
          title={`Hold ${sc('alt')} and click to apply to the whole project`}
          onClick={(alt) => void respond(sessionId, requestId, 'always', alt ? 'project' : 'session')}
        />
        <span className="ml-auto text-[10px] text-ink-faint">
          <Kbd alt /> <Kbd>a</Kbd> whole project
        </span>
      </div>
    </div>
  )
}

/**
 * An app's capability-question card (M4 D-4) — the same shape as the approval card (left rail,
 * header, y/n buttons). ApprovalCard puts this up inside a session; CapabilityAsk puts it up in
 * an app's pinned view. The same question has to wear the same face wherever it stands, for it
 * to read to a person as the same thing.
 *
 * There is no "always allow": both allow and deny are remembered from a single answer. The card
 * states where to reverse it (Permissions in the settings panel).
 */
export function PermissionCard({
  appName,
  text,
  onAnswer,
  testId = 'approval-card',
}: {
  appName: string
  text: string
  onAnswer: (decision: 'allow' | 'deny') => void
  testId?: string
}) {
  return (
    <div
      className="overflow-hidden rounded border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid={testId}
      data-kind="capability"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-[10px] font-medium">Awaiting approval</span>
        <span className="text-[11px] text-ink-faint">An app asks for a permission, and waits</span>
      </div>
      <p className="mt-2 px-3 text-[13px] leading-relaxed text-ink" data-testid="approval-detail">
        {appName} wants to {text}.
      </p>
      <p className="mt-1 px-3 text-[11px] leading-relaxed text-ink-faint">
        Centralu remembers your answer for this app and asks again if the app&apos;s manifest changes what it uses. You can
        change it later under Runs → Permissions.
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k="y" label="Allow" onClick={() => onAnswer('allow')} testId="approve-allow" />
        <ActionKey k="n" label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" />
      </div>
    </div>
  )
}

function ActionKey({
  k,
  label,
  onClick,
  testId,
  title,
  disabled,
}: {
  k: string
  label: string
  onClick: (alt: boolean) => void
  testId: string
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
      onClick={(e) => onClick(e.altKey)}
      disabled={disabled}
      data-testid={testId}
      title={title}
    >
      <Kbd live>{k}</Kbd>
      {label}
    </button>
  )
}

export type ApprovalKeyAction = { decision: 'allow' | 'deny' | 'always'; scope?: 'session' | 'project' }

/**
 * Whether this card should accept a key press right now (a pure function — tests attach here).
 *
 * Besides being covered by a modal or overlay, **a card belonging to a session that is not
 * focused** must not accept one either: in the grid, each pane's card attaches its own window
 * listener, so with two or more approvals up at once, a single y **approved all of them at
 * once** — the single most dangerous button to have mis-fire in this app. Keyboard approval
 * always goes to exactly one thing: "the session currently focused."
 */
export function approvalCardCovered(
  st: {
    inboxOpen: boolean
    usageOpen: boolean
    settingsOpen: boolean
    paletteOpen: boolean
    overlay: unknown
    focusedSessionId: string | null
    /** The count of windows opened via local state (delete confirmation, new session, image zoom, command palette…) — `Modal` counts itself (#158) */
    openLayers: number
  },
  sessionId: string,
): boolean {
  return (
    st.openLayers > 0 ||
    st.inboxOpen ||
    st.usageOpen ||
    st.settingsOpen ||
    st.paletteOpen ||
    st.overlay !== null ||
    st.focusedSessionId !== sessionId
  )
}

/**
 * The complete rule for **when** the global y/n/a keys turn into an approval (a pure function —
 * tests attach here).
 *
 * A ⌘, ⌃ or ⇧ combination is a different shortcut: ⌘A (select all) and ⌘⇧A (next waiting, which
 * this app advertises in the top bar) used to flow straight through and trigger "always allow" —
 * approval is the single most dangerous button to have mis-fire in this app. Only ⌥ is let
 * through (⌥a is the established convention for project scope). Neither typing into a text field
 * nor a card hidden behind a modal or overlay is accepted.
 */
export function approvalKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { repeat?: boolean },
  ctx: { typing: boolean; covered: boolean },
): ApprovalKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null
  /*
   * A key held down and repeating is not an approval (#158). Holding y down meant that the
   * moment the next card appeared after the first response, it too got approved before anyone
   * had read it.
   */
  if (e.repeat) return null
  if (ctx.typing || ctx.covered) return null
  // A letter is read by **meaning**, not by keycap — with ⌥ held, or on a Korean keyboard layout, `key` is a different character (app/keys.ts)
  const k = letterOf(e)
  if (k === 'y') return { decision: 'allow' }
  if (k === 'n') return { decision: 'deny' }
  if (k === 'a') return { decision: 'always', scope: e.altKey ? 'project' : 'session' }
  return null
}

export function detailText(d: ApprovalDetail): string {
  if (d.kind === 'command') return `${d.command}\n${d.cwd}`
  if (d.kind === 'file_edit') return `${d.path}\n\n${d.diffPreview}`
  if (d.kind === 'capability') return `${d.app.name} wants to ${d.text}`
  return d.raw
}

