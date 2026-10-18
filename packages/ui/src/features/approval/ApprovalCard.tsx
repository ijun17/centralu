import { useEffect, useState } from 'react'
import {
  alwaysAllowKey,
  isCentraluApply,
  isUnknownCard,
  SESSION_HANDOFF,
  sessionOnlyAlways,
  type ApprovalDetail,
} from '@cc/protocol'
import {
  agentStartQuestion,
  approvalNotes,
  centraluUpdateQuestion,
  projectAccessQuestion,
  projectCreateQuestion,
} from '@cc/core'
import { inFlightKey, useStore } from '../../store/store.js'
import { isCovered, type CoveringLayers } from '../../store/layers.js'
import { useShortcut } from '../../app/shortcut.js'
import { composingKey, letterOf } from '../../app/keys.js'
import { Kbd } from '../../components/primitives.jsx'
import { Pill } from '../../components/Pill.jsx'

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
  const busy = useStore((s) => !!s.approvalsInFlight[inFlightKey(sessionId, requestId)])
  const sc = useShortcut()
  const inComposer = useComposerFocused(sessionId)
  // An update card (#581), an agent's apply card (#665) or the orchestrator's handoff card (#694): its "always" is for this session only, never the project
  const updateCard = sessionOnlyAlways(detail)
  // An edit whose file is unknown has nothing to remember (#428): no button, and `a` does nothing
  const canAlways = offersAlways(detail)
  const keys: AnswerKeys = inComposer
    ? {
        allow: sc(...APPROVAL_COMBOS.allow),
        deny: sc(...APPROVAL_COMBOS.deny),
        always: sc(...APPROVAL_COMBOS.always),
      }
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
      if ((detail.kind === 'capability' || detail.kind === 'project_create') && action.decision === 'always')
        return
      // Nor does an edit whose file is unknown (#428): there is no path to remember
      if (!canAlways && action.decision === 'always') return
      // Nor does a project of another machine (#700): the consent is for this call, nothing is remembered for it
      if (detail.kind === 'project_access' && detail.to.machine && action.decision === 'always') return
      // Nor an agent started on another machine (#1038), for the same reason
      if (detail.kind === 'agent_start' && detail.machine && action.decision === 'always') return
      // A cross-project consent's "always" is for the pair (#371) — there is no session or project scope to pick
      if (detail.kind === 'project_access') {
        void respond(sessionId, requestId, action.decision)
        e.preventDefault()
        return
      }
      // An update or handoff grant is deliberately per-session only; it must not become an app-wide setting.
      if (sessionOnlyAlways(detail)) {
        void respond(sessionId, requestId, action.decision)
        e.preventDefault()
        return
      }
      // The "always allow" toast is shown using the matcher the store sent back (#170)
      void respond(sessionId, requestId, action.decision, keyScope(detail, action))
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, requestId, detail, canAlways, respond])

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

  if (detail.kind === 'agent_start') {
    return (
      <AgentStartCard
        detail={detail}
        busy={busy}
        keys={keys}
        projectHint={sc('alt')}
        showProjectKey={!inComposer}
        onAnswer={(decision, scope) => void respond(sessionId, requestId, decision, scope)}
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
    /*
      Every card that waits on the person (approvals here, questions in QuestionCard) is drawn alike (owner,
      2026-10-18): the conversation's 14px corner, a white border all round as the inbox capsule's for an approval
      (white is what waits on the person), the kind as a capsule, and the answers on a plain footer below a hairline.
    */
    <div
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-keys={inComposer ? 'composer' : 'bare'}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          Awaiting approval
        </Pill>
        <span className="text-xs text-ink-faint">Agent is blocked, waiting</span>
      </div>

      <pre
        className="mt-2 whitespace-pre-wrap break-words px-3 font-mono text-sm leading-body text-ink"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
        <ActionKey
          k={keys.allow}
          label="Allow"
          onClick={() => void respond(sessionId, requestId, 'allow')}
          testId="approve-allow"
          disabled={busy}
        />
        <ActionKey
          k={keys.deny}
          label="Deny"
          onClick={() => void respond(sessionId, requestId, 'deny')}
          testId="approve-deny"
          disabled={busy}
        />
        {canAlways && (
          <ActionKey
            k={keys.always}
            label="Always allow"
            testId="approve-always"
            disabled={busy}
            title={
              isCentraluApply(detail)
                ? 'Allow this session to apply Centralu updates while it is running'
                : detail.kind === 'other' && detail.about === SESSION_HANDOFF
                  ? 'Allow this session to hand off sessions while it is running'
                  : detail.kind === 'centralu_update'
                    ? 'Allow Centralu updates from this session while it is running'
                    : `Hold ${sc('alt')} and click to apply to the whole project`
            }
            onClick={(alt) =>
              void respond(
                sessionId,
                requestId,
                'always',
                updateCard ? 'session' : alt ? 'project' : 'session',
              )
            }
          />
        )}
        {/* Project scope is ⌥a, a letter: from the composer it stays a click with ⌥ held (the button's title says so) */}
        {!inComposer && !updateCard && canAlways && (
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
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid={testId}
      data-kind="capability"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          Awaiting approval
        </Pill>
        <span className="text-xs text-ink-faint">An app asks for a permission, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {appName} wants to {text}.
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        Centralu remembers your answer for this app and asks again if the app&apos;s manifest changes what it
        uses. You can change it later under Runs → Permissions.
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
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
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-kind="project_access"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          Awaiting approval
        </Pill>
        <span className="text-xs text-ink-faint">This session wants to reach another project, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {projectAccessQuestion(detail)}
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        {detail.access === 'delegate'
          ? `The task goes to an existing session in ${detail.to.name}${detail.to.machine ? ` on ${detail.to.machine}, which works with its own logins and folder there` : ', with its own folder, instructions and permissions'}, and its answer comes back here.`
          : `The app's tools attach to this session while it uses them.`}{' '}
        {detail.to.machine
          ? 'Nothing is remembered for a project on another machine: it asks each time.'
          : `Always is remembered for ${detail.from.name} → ${detail.to.name}; revoke it in Settings.`}
      </p>
      {detail.to.trusted === false && (
        <p className="mt-1 px-3 text-xs leading-body text-ink-signal" data-testid="approval-untrusted">
          You have not trusted {detail.to.name}. The session there reads none of its settings or instruction
          files and runs none of its apps, but it works on that project&apos;s files under your own permission
          settings.
        </p>
      )}
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
        <ActionKey
          k={keys.allow}
          label="Allow once"
          onClick={() => onAnswer('allow')}
          testId="approve-allow"
          disabled={busy}
        />
        {!detail.to.machine && (
          <ActionKey
            k={keys.always}
            label="Always for this pair"
            onClick={() => onAnswer('always')}
            testId="approve-always"
            disabled={busy}
          />
        )}
        <ActionKey
          k={keys.deny}
          label="Deny"
          onClick={() => onAnswer('deny')}
          testId="approve-deny"
          disabled={busy}
        />
      </div>
    </div>
  )
}

/**
 * A session asks to start another agent in its project (#561, start_agent). Four answers, the approval card's own
 * keys: once (y), always for this session (a), always for the whole project (⌥a, or ⌥ with a click; stored and
 * revoked in Settings), deny (n). The new session's permissions are said on the card, since that is the line the
 * person is agreeing to: the caller's own preset, never more.
 */
function AgentStartCard({
  detail,
  busy,
  keys,
  projectHint,
  showProjectKey,
  onAnswer,
}: {
  detail: Extract<ApprovalDetail, { kind: 'agent_start' }>
  busy: boolean
  keys: AnswerKeys
  /** The modifier's name for the "whole project" hint (⌥ or Alt) */
  projectHint: string
  /** ⌥a is a letter, so the hint shows only while the keyboard is outside the composer */
  showProjectKey: boolean
  onAnswer: (decision: 'allow' | 'deny' | 'always', scope?: 'session' | 'project') => void
}) {
  // The orchestrator's child (#853) works in no project: there is no project to always allow it for
  const inProject = detail.project.id !== ''
  // A child on a linked machine (#1038) is allowed once: nothing is remembered for another machine's project
  const remote = !!detail.machine
  return (
    <div
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-kind="agent_start"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          Awaiting approval
        </Pill>
        <span className="text-xs text-ink-faint">This session wants to start another agent, and waits</span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {agentStartQuestion(detail)}
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        {remote
          ? `It opens on ${detail.machine}, in that machine's checkout of this repository, with that machine's own logins and its own approvals and Stop there; its answer comes back here. Nothing is remembered for another machine: it asks each time.`
          : inProject
            ? 'It opens as its own session in this project, linked to this one, with its own approvals and Stop; its answer comes back here. Always for the project is remembered; revoke it in Settings.'
            : 'It opens as its own session under this one, in a folder of its own outside any project, with its own approvals and Stop; its answer comes back here. Always for this session lasts until Centralu restarts.'}
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
        <ActionKey
          k={keys.allow}
          label="Allow once"
          onClick={() => onAnswer('allow')}
          testId="approve-allow"
          disabled={busy}
        />
        {!remote && (
          <ActionKey
            k={keys.always}
            label="Always for this session"
            title={inProject ? `Hold ${projectHint} and click for the whole project` : undefined}
            onClick={(alt) => onAnswer('always', agentStartScope(detail, alt))}
            testId="approve-always"
            disabled={busy}
          />
        )}
        {inProject && !remote && (
          <button
            className="rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-50"
            onClick={() => onAnswer('always', 'project')}
            disabled={busy}
            data-testid="approve-always-project"
          >
            Always for this project
          </button>
        )}
        <ActionKey
          k={keys.deny}
          label="Deny"
          onClick={() => onAnswer('deny')}
          testId="approve-deny"
          disabled={busy}
        />
        {showProjectKey && inProject && !remote && (
          <span className="ml-auto text-2xs text-ink-faint">
            <Kbd alt /> <Kbd>a</Kbd> whole project
          </span>
        )}
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
      className="overflow-hidden rounded-bubble border border-ink-signal bg-surface-raised"
      data-testid="approval-card"
      data-kind="project_create"
      data-keys={keys === BARE_KEYS ? 'bare' : 'composer'}
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <Pill size="label" edge="solid" tone="bright">
          Awaiting approval
        </Pill>
        <span className="text-xs text-ink-faint">
          The orchestrator wants to make a new project, and waits
        </span>
      </div>
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {detail.source ? 'Clone a repository as the new project' : 'Make a new project'}{' '}
        <span className="readout">{detail.name}</span>
        {detail.machine ? (
          <>
            {' '}
            on{' '}
            <span className="readout" data-testid="approval-machine">
              {detail.machine}
            </span>
          </>
        ) : null}
        ?
      </p>
      {detail.source && (
        <p
          className="mt-1 break-all px-3 font-mono text-xs leading-body text-ink"
          data-testid="approval-source"
        >
          {detail.source.git}
          {detail.source.branch ? ` (branch ${detail.source.branch})` : ''}
        </p>
      )}
      <p
        className="mt-1 break-all px-3 font-mono text-xs leading-body text-ink-muted"
        data-testid="approval-path"
      >
        {detail.source ? 'into ' : ''}
        {detail.path}
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        {detail.source
          ? `It is cloned with ${detail.machine ? `${detail.machine}'s` : "this machine's"} own git and saved sign-ins, without its submodules, and added to the sidebar. Nothing is made unless you choose Create.`
          : 'An empty folder is made there and added to the sidebar. Nothing is made unless you choose Create.'}
      </p>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line/70 px-3 py-2">
        <ActionKey
          k={keys.allow}
          label="Create"
          onClick={() => onAnswer('allow')}
          testId="approve-allow"
          disabled={busy}
        />
        <ActionKey
          k={keys.deny}
          label="Deny"
          onClick={() => onAnswer('deny')}
          testId="approve-deny"
          disabled={busy}
        />
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

/**
 * Whether the card offers "always allow". Not for a file edit whose path is unknown (#428): the rule would be
 * "(no path)", which the host never matches, so it would be saved, listed and announced while doing nothing. Not for
 * a command with no key either (#838): an empty one, one the card flags (outside the sandbox, the network, input to a
 * running terminal) since a rule of its text would also let the plain command through, and one ending in `*`, which
 * an older host reads as a prefix. Nor for a card this window could not read (#844): "always" would remember a
 * question the person never saw in full.
 */
export function offersAlways(detail: ApprovalDetail): boolean {
  if (isUnknownCard(detail)) return false
  return (detail.kind !== 'file_edit' && detail.kind !== 'command') || alwaysAllowKey(detail) !== ''
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
  st: CoveringLayers & { focusedSessionId: string | null },
  sessionId: string,
): boolean {
  return isCovered(st) || st.focusedSessionId !== sessionId
}

/**
 * The scope a key answers with: what the key asked for (⌥a is the project), except on a start_agent card, whose "always"
 * reaches only as far as the card's button lets it (`agentStartScope`).
 */
export function keyScope(
  detail: ApprovalDetail,
  action: { decision: 'allow' | 'deny' | 'always'; scope?: 'session' | 'project' },
): 'session' | 'project' | undefined {
  return detail.kind === 'agent_start' && action.decision === 'always'
    ? agentStartScope(detail, action.scope === 'project')
    : action.scope
}

/**
 * How far "always" on a start_agent card reaches. The project when the person asked for it (⌥a, or ⌥ and a click) and the
 * child has one; the orchestrator's child works in no project (#853), so there is none to remember it for and it stays
 * this session's. The button and the key both ask here: the key sent `project` for the orchestrator's card, and the
 * toast said sessions in a project may start agents when the host had remembered it for this session only.
 */
export function agentStartScope(detail: { project: { id: string } }, wantsProject: boolean): 'session' | 'project' {
  return wantsProject && detail.project.id !== '' ? 'project' : 'session'
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
function approvalComboOf(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): ApprovalKeyAction | null {
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
  const [focused, setFocused] = useState(
    () => composerOf(typeof document === 'undefined' ? null : document.activeElement) === sessionId,
  )
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

/**
 * The card's text, which a list row's tooltip shows too (#543). What the request says beyond its command or path
 * (`approvalNotes`: network access, input to a running terminal, outside the sandbox, the reason, a delete or a move)
 * stands under it, so nothing the agent asked for is only in the row's head (#683 review).
 */
export function detailText(d: ApprovalDetail): string {
  const notes = approvalNotes(d)
  if (d.kind === 'command') return [d.command, d.cwd, ...notes].filter((line) => line !== '').join('\n')
  if (d.kind === 'file_edit') return `${[d.path, ...notes].join('\n')}\n\n${d.diffPreview}`
  if (d.kind === 'capability') return `${d.app.name} wants to ${d.text}`
  if (d.kind === 'project_access') return projectAccessQuestion(d)
  if (d.kind === 'project_create') return projectCreateQuestion(d)
  // The host writes the whole question with every fact the card shows (#1220)
  if (d.kind === 'project_add') return d.text
  if (d.kind === 'agent_start') return agentStartQuestion(d)
  if (d.kind === 'centralu_update') return centraluUpdateQuestion(d)
  return d.raw
}
