import { useEffect, useState } from 'react'
import type { ApprovalDetail } from '@cc/protocol'
import { projectAccessQuestion, projectCreateQuestion } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { composingKey, letterOf } from '../../app/keys.js'
import { Kbd } from '../../components/primitives.jsx'

/**
 * Approval card (FR-3). Keyboard first — y/n/a, ⌥a scopes it to the project. With the keyboard in this session's
 * composer, where y/n/a are letters of the message, mod+⇧Y / mod+⇧D / mod+⇧L answer it instead, and the card shows those.
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
  const inComposer = useComposerFocused(sessionId)
  const keys: AnswerKeys = inComposer
    ? { allow: sc(...APPROVAL_COMBOS.allow), deny: sc(...APPROVAL_COMBOS.deny), always: sc(...APPROVAL_COMBOS.always) }
    : BARE_KEYS

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable,
        // Ignored if the card is behind another screen or **is not the card of the focused session** —
        // when several cards are up in the grid, a single y must not approve all of them
        covered: approvalCardCovered(st, sessionId),
        inComposer: composerOf(e.target) === sessionId,
      })
      if (!action) return
      // A capability question (M4 D-4) has no "always allow" — the answer gets remembered either way. `a` does nothing on this card
      // Nor does a new project (#515): it is one folder, made once — there is nothing to always allow
      if ((detail.kind === 'capability' || detail.kind === 'project_create') && action.decision === 'always') return
      // A cross-project consent's "always" is for the pair (#371) — there is no session or project scope to pick
      if (detail.kind === 'project_access') {
        void respond(sessionId, requestId, action.decision)
        e.preventDefault()
        return
      }
      // The "always allow" toast is shown using the matcher the store sent back (#170)
      void respond(sessionId, requestId, action.decision, action.scope)
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, respond])

  if (detail.kind === 'project_access') {
    return (
      <ProjectAccessCard
        detail={detail}
        busy={busy}
        keys={keys}
        onAnswer={(decision) => void respond(sessionId, requestId, decision)}
      />
    )
  }

  if (detail.kind === 'project_create') {
    return (
      <ProjectCreateCard
        detail={detail}
        busy={busy}
        keys={keys}
        onAnswer={(decision) => void respond(sessionId, requestId, decision)}
      />
    )
  }

  if (detail.kind === 'capability') {
    return (
      <PermissionCard
        appName={detail.app.name}
        text={detail.text}
        keys={keys}
        onAnswer={(decision) => void respond(sessionId, requestId, decision)}
      />
    )
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-keys={inComposer ? 'composer' : 'bare'}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-2xs font-medium">
          Awaiting approval
        </span>
        <span className="text-xs text-ink-faint">Agent is blocked, waiting</span>
      </div>

      <pre
        className="mt-2 whitespace-pre-wrap break-words px-3 font-mono text-sm leading-body text-ink"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k={keys.allow} label="Allow" onClick={() => void respond(sessionId, requestId, 'allow')} testId="approve-allow" disabled={busy} />
        <ActionKey k={keys.deny} label="Deny" onClick={() => void respond(sessionId, requestId, 'deny')} testId="approve-deny" disabled={busy} />
        <ActionKey
          k={keys.always}
          label="Always allow"
          testId="approve-always"
          disabled={busy}
          title={`Hold ${sc('alt')} and click to apply to the whole project`}
          onClick={(alt) => void respond(sessionId, requestId, 'always', alt ? 'project' : 'session')}
        />
        {/* Project scope is ⌥a, a letter: from the composer it stays a click with ⌥ held (the button's title says so) */}
        {!inComposer && (
          <span className="ml-auto text-2xs text-ink-faint">
            <Kbd alt /> <Kbd>a</Kbd> whole project
          </span>
        )}
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
  keys = BARE_KEYS,
}: {
  appName: string
  text: string
  onAnswer: (decision: 'allow' | 'deny') => void
  testId?: string
  keys?: AnswerKeys
}) {
  return (
    <div
      className="overflow-hidden rounded-md border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid={testId}
      data-kind="capability"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-2xs font-medium">Awaiting approval</span>
        <span className="text-xs text-ink-faint">An app asks for a permission, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {appName} wants to {text}.
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        Centralu remembers your answer for this app and asks again if the app&apos;s manifest changes what it uses. You can
        change it later under Runs → Permissions.
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k={keys.allow} label="Allow" onClick={() => onAnswer('allow')} testId="approve-allow" />
        <ActionKey k={keys.deny} label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" />
      </div>
    </div>
  )
}

/**
 * One project reaching another (#371) — the first time a session of one project asks another project to do
 * something (ask_project) or to lend its apps. Three answers, unlike an app's capability question: once is this
 * call only, always is remembered for the pair (and listed in Settings, where it is revoked), deny is not
 * remembered. The task itself is shown whole below the question, since that is what the person is agreeing to.
 */
function ProjectAccessCard({
  detail,
  busy,
  keys,
  onAnswer,
}: {
  detail: Extract<ApprovalDetail, { kind: 'project_access' }>
  busy: boolean
  keys: AnswerKeys
  onAnswer: (decision: 'allow' | 'deny' | 'always') => void
}) {
  return (
    <div
      className="overflow-hidden rounded-md border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-kind="project_access"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-2xs font-medium">Awaiting approval</span>
        <span className="text-xs text-ink-faint">This session wants to reach another project, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {projectAccessQuestion(detail)}
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        {detail.access === 'delegate'
          ? `A session opens in ${detail.to.name} with its own folder, instructions and permissions, and its answer comes back here.`
          : `The app's tools attach to this session while it uses them.`}{' '}
        Always is remembered for {detail.from.name} → {detail.to.name}; revoke it in Settings.
      </p>
      {detail.to.trusted === false && (
        <p className="mt-1 px-3 text-xs leading-body text-ink-signal" data-testid="approval-untrusted">
          You have not trusted {detail.to.name}. The session there reads none of its settings or instruction files and
          runs none of its apps, but it works on that project&apos;s files under your own permission settings.
        </p>
      )}
      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k={keys.allow} label="Allow once" onClick={() => onAnswer('allow')} testId="approve-allow" disabled={busy} />
        <ActionKey k={keys.always} label="Always for this pair" onClick={() => onAnswer('always')} testId="approve-always" disabled={busy} />
        <ActionKey k={keys.deny} label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" disabled={busy} />
      </div>
    </div>
  )
}

/**
 * The orchestrator asks to make a new project (#515, create_project). The full path stands on the card, since where
 * the folder goes is the whole of what is agreed to; nothing exists until Create. No "always": it is one folder.
 */
function ProjectCreateCard({
  detail,
  busy,
  keys,
  onAnswer,
}: {
  detail: Extract<ApprovalDetail, { kind: 'project_create' }>
  busy: boolean
  keys: AnswerKeys
  onAnswer: (decision: 'allow' | 'deny') => void
}) {
  return (
    <div
      className="overflow-hidden rounded-md border border-line border-l-2 border-l-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-kind="project_create"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span className="signal text-2xs font-medium">Awaiting approval</span>
        <span className="text-xs text-ink-faint">The orchestrator wants to make a new project, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {detail.source ? 'Clone a repository as the new project' : 'Make a new project'} <span className="readout">{detail.name}</span>
        {detail.machine ? (
          <>
            {' '}
            on <span className="readout" data-testid="approval-machine">{detail.machine}</span>
          </>
        ) : null}
        ?
      </p>
      {detail.source && (
        <p className="mt-1 break-all px-3 font-mono text-xs leading-body text-ink" data-testid="approval-source">
          {detail.source.git}
          {detail.source.branch ? ` (branch ${detail.source.branch})` : ''}
        </p>
      )}
      <p className="mt-1 break-all px-3 font-mono text-xs leading-body text-ink-muted" data-testid="approval-path">
        {detail.source ? 'into ' : ''}
        {detail.path}
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        {detail.source
          ? `It is cloned with ${detail.machine ? `${detail.machine}'s` : "this machine's"} own git and saved sign-ins, without its submodules, and added to the sidebar. Nothing is made unless you choose Create.`
          : 'An empty folder is made there and added to the sidebar. Nothing is made unless you choose Create.'}
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line bg-surface-floor/40 px-3 py-2">
        <ActionKey k={keys.allow} label="Create" onClick={() => onAnswer('allow')} testId="approve-allow" disabled={busy} />
        <ActionKey k={keys.deny} label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" disabled={busy} />
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
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
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
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
    Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode'>> & { repeat?: boolean },
  ctx: {
    typing: boolean
    covered: boolean
    /** The keyboard is in the composer of the session this card belongs to (`data-composer-session`) */
    inComposer?: boolean
  },
): ApprovalKeyAction | null {
  /*
   * A key held down and repeating is not an approval (#158). Holding y down meant that the
   * moment the next card appeared after the first response, it too got approved before anyone
   * had read it.
   */
  if (e.repeat || ctx.covered) return null
  // A key an input method is using belongs to the composition, whatever modifiers it carries (app/keys.ts)
  if (composingKey({ key: e.key, isComposing: !!e.isComposing, keyCode: e.keyCode ?? 0 })) return null
  const combo = approvalComboOf(e)
  if (combo) return ctx.inComposer || !ctx.typing ? combo : null
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null
  if (ctx.typing) return null
  // A letter is read by **meaning**, not by keycap — with ⌥ held, or on a Korean keyboard layout, `key` is a different character (app/keys.ts)
  const k = letterOf(e)
  if (k === 'y') return { decision: 'allow' }
  if (k === 'n') return { decision: 'deny' }
  if (k === 'a') return { decision: 'always', scope: e.altKey ? 'project' : 'session' }
  return null
}

/**
 * The combos that answer a card while the keyboard is in the composer, where bare y/n/a are letters of the message.
 * `mod` is ⌘ on a Mac and Ctrl elsewhere; written by meaning, named by the keyboard (`useShortcut`).
 */
export const APPROVAL_COMBOS = {
  allow: ['mod', '⇧Y'],
  deny: ['mod', '⇧D'],
  always: ['mod', '⇧L'],
} as const

/**
 * mod+⇧Y allow, mod+⇧D deny, mod+⇧L always allow (session scope), with exactly those modifiers. Chosen against what a
 * key already does in the composer or the window (2026-10-12):
 *
 *  - mod+Enter is the composer's send key when "send with ⌘Enter" is on (composerKeys.ts), and mod+Backspace deletes a
 *    word (Windows, Linux) or back to the line's start (macOS): both are what a person typing means by them.
 *  - Bare mod+letters are taken or edit text: ⌘A/C/V/X/Z, Ctrl+Y redo, ⌘N/⌘W/⌘M/⌘H/⌘Q (window and app keys),
 *    mod+K/I/B and mod+1-9 here. mod+⇧A is "next waiting" (a global shortcut on the desktop), mod+⇧Z redo,
 *    mod+⇧N/⇧F are new session and search (#529), mod+⇧I/J/C/R are WebView2's developer tools and hard reload.
 *  - No Alt: Ctrl+Alt is AltGr on many Windows layouts, where it types letters (Polish AltGr+N is ń).
 *
 * Y mirrors the bare y; D is Deny; L is the "always" one, kept off the keys a hand reaches for by habit. "Always" here
 * is session scope: project scope stays on ⌥a and ⌥-click, outside the composer.
 */
function approvalComboOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): ApprovalKeyAction | null {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return null
  const k = letterOf(e)
  if (k === 'y') return { decision: 'allow' }
  if (k === 'd') return { decision: 'deny' }
  if (k === 'l') return { decision: 'always', scope: 'session' }
  return null
}

/** Is the keyboard in this session's composer right now — the card then shows its combos instead of y/n/a */
export function composerOf(target: EventTarget | null): string | null {
  const el = target as HTMLElement | null
  return el?.dataset?.composerSession ?? null
}

/** Follows the keyboard into and out of a session's composer, for the hints on its card */
function useComposerFocused(sessionId: string): boolean {
  const [focused, setFocused] = useState(() => composerOf(typeof document === 'undefined' ? null : document.activeElement) === sessionId)
  useEffect(() => {
    /*
     * Read after the event, not in it: focus moved by a component's layout effect fires focusin inside React's commit,
     * where a state update is a flushSync from a lifecycle (React warns). By the microtask, activeElement is settled too.
     */
    let live = true
    const update = () =>
      queueMicrotask(() => {
        if (live) setFocused(composerOf(document.activeElement) === sessionId)
      })
    update()
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      live = false
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
    }
  }, [sessionId])
  return focused
}

/** The key each answer shows on the card: the bare letter, or the combo while the keyboard is in the composer */
export type AnswerKeys = { allow: string; deny: string; always: string }

const BARE_KEYS: AnswerKeys = { allow: 'y', deny: 'n', always: 'a' }

export function detailText(d: ApprovalDetail): string {
  if (d.kind === 'command') return `${d.command}\n${d.cwd}`
  if (d.kind === 'file_edit') return `${d.path}\n\n${d.diffPreview}`
  if (d.kind === 'capability') return `${d.app.name} wants to ${d.text}`
  if (d.kind === 'project_access') return projectAccessQuestion(d)
  if (d.kind === 'project_create') return projectCreateQuestion(d)
  return d.raw
}

