import { useEffect, useState } from 'react'
import {
  alwaysAllowKey,
  isCentraluApply,
  isMachineChange,
  isAssistantChange,
  isAppCall,
  isUnknownCard,
  SESSION_HANDOFF,
  sessionOnlyAlways,
  type ApprovalDetail,
} from '@cc/protocol/client'
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
import { composingKey, isTextEntry, letterOf } from '../../app/keys.js'
import { Kbd } from '../../components/primitives.jsx'
import { WaitCard, WaitFooter } from './WaitCard.jsx'

/**
 * Approval card (FR-3; look: docs/design-system.md §8). Keyboard first: y/n/a, ⌥a for the project; from this session's
 * composer, where those are letters, the `APPROVAL_COMBOS`, which the card then shows.
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
  // Disabled while an answer is in flight: a second one would record an executed command as denied (#158)
  const busy = useStore((s) => !!s.approvalsInFlight[inFlightKey(sessionId, requestId)])
  const sc = useShortcut()
  const inComposer = useComposerFocused(sessionId)
  // An update (#581), apply (#665) or handoff (#694) card: "always" is this session's only, never the project's
  const updateCard = sessionOnlyAlways(detail)
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
      const st = useStore.getState()
      const action = approvalKeyAction(e, {
        typing: isTextEntry(e.target),
        // Only the focused session's uncovered card: one y must not approve every card in the grid
        covered: approvalCardCovered(st, sessionId),
        inComposer: composerOf(e.target) === sessionId,
      })
      if (!action) return
      // `a` does nothing on a capability question (remembered either way) or a new or added project (one folder, #515, #1220)
      if ((detail.kind === 'capability' || detail.kind === 'project_create' || detail.kind === 'project_add') && action.decision === 'always')
        return
      // Nor where `offersAlways` says no (#428)
      if (!canAlways && action.decision === 'always') return
      // Nor does a project of another machine (#700): the consent is for this call, nothing is remembered for it
      if (detail.kind === 'project_access' && detail.to.machine && action.decision === 'always') return
      // Nor an ask from a linked machine's session (#550): Allow is already remembered for its pair
      if (detail.kind === 'project_access' && detail.from.machine && action.decision === 'always') return
      // Nor an agent started on another machine (#1038), for the same reason
      if (detail.kind === 'agent_start' && detail.machine && action.decision === 'always') return
      // A cross-project "always" is for the pair (#371): no scope to pick
      if (detail.kind === 'project_access') {
        void respond(sessionId, requestId, action.decision)
        e.preventDefault()
        return
      }
      // An update or handoff grant stays per-session, never an app-wide setting
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

  if (detail.kind === 'project_add') {
    return (
      <ProjectAddCard
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
    <WaitCard
      testId="approval-card"
      keys={inComposer ? 'composer' : 'bare'}
      subtitle="Agent is blocked, waiting"
    >
      <pre
        className="mt-2 whitespace-pre-wrap break-words px-3 font-mono text-sm leading-body text-ink"
        data-testid="approval-detail"
      >
        {detailText(detail)}
      </pre>

      <WaitFooter>
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
      </WaitFooter>
    </WaitCard>
  )
}

/**
 * An app's capability question, the same card in a session (ApprovalCard) and a pinned view (CapabilityAsk). No "always":
 * either answer is remembered, and the card says where to change it.
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
    <WaitCard
      testId={testId}
      kind="capability"
      keys={keys === BARE_KEYS ? 'bare' : 'composer'}
      subtitle="An app asks for a permission, and waits"
    >
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {appName} wants to {text}.
      </p>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        Centralu remembers your answer for this app. You can change it later under Runs → Permissions.
      </p>
      <WaitFooter>
        <ActionKey k={keys.allow} label="Allow" onClick={() => onAnswer('allow')} testId="approve-allow" />
        <ActionKey k={keys.deny} label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" />
      </WaitFooter>
    </WaitCard>
  )
}

/**
 * A project's first ask_project or app loan to another (#371). Once is this call, always is the pair's (revoked in
 * Settings), deny is not remembered. The task stands whole, since that is what is agreed to.
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
    <WaitCard
      testId="approval-card"
      kind="project_access"
      keys={keys === BARE_KEYS ? 'bare' : 'composer'}
      subtitle={
        detail.from.machine
          ? `A session on ${detail.from.machine} wants to ask a project here, and waits`
          : 'This session wants to reach another project, and waits'
      }
    >
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        {projectAccessQuestion(detail)}
      </p>
      {detail.from.machine ? (
        <p className="mt-1 px-3 text-xs leading-body text-ink-faint" data-testid="approval-from-machine">
          The task goes to this session, which works on it with its own folder, instructions and permissions on this
          computer, and its answer goes back to {detail.from.machine}. Allow is remembered for this session of{' '}
          {detail.from.machine} and {detail.to.name}: its later asks need no card until you withdraw it in Settings →
          Machines.
        </p>
      ) : (
        <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
          {detail.access === 'delegate'
            ? `The task goes to an existing session in ${detail.to.name}${detail.to.machine ? ` on ${detail.to.machine}, which works with its own logins and folder there` : ', with its own folder, instructions and permissions'}, and its answer comes back here.`
            : `The app's tools attach to this session while it uses them.`}{' '}
          {detail.to.machine
            ? 'Nothing is remembered for a project on another machine: it asks each time.'
            : `Always is remembered for ${detail.from.name} → ${detail.to.name}; revoke it in Settings.`}
        </p>
      )}
      {detail.to.trusted === false && (
        <p className="mt-1 px-3 text-xs leading-body text-ink-signal" data-testid="approval-untrusted">
          You have not trusted {detail.to.name}. The session there reads none of its settings or instruction
          files and runs none of its apps, but it works on that project&apos;s files under your own permission
          settings.
        </p>
      )}
      <WaitFooter>
        <ActionKey
          k={keys.allow}
          label={detail.from.machine ? 'Allow' : 'Allow once'}
          onClick={() => onAnswer('allow')}
          testId="approve-allow"
          disabled={busy}
        />
        {!detail.to.machine && !detail.from.machine && (
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
      </WaitFooter>
    </WaitCard>
  )
}

/**
 * start_agent (#561): once (y), always for this session (a) or the project (⌥a, ⌥-click; revoked in Settings), deny (n).
 * The card states the child's permissions, the caller's own preset and never more, since that is what is agreed to.
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
  // The Assistant's child (#853) has no project to always allow it for
  const inProject = detail.project.id !== ''
  // A child on a linked machine (#1038) is allowed once: nothing is remembered for another machine's project
  const remote = !!detail.machine
  return (
    <WaitCard
      testId="approval-card"
      kind="agent_start"
      keys={keys === BARE_KEYS ? 'bare' : 'composer'}
      subtitle="This session wants to start another agent, and waits"
    >
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
      <WaitFooter>
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
      </WaitFooter>
    </WaitCard>
  )
}

/** create_project (#515): the full path is what is agreed to, and nothing exists until Create. No "always": one folder */
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
    <WaitCard
      testId="approval-card"
      kind="project_create"
      keys={keys === BARE_KEYS ? 'bare' : 'composer'}
      subtitle="The Assistant wants to make a new project, and waits"
    >
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
      <WaitFooter>
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
      </WaitFooter>
    </WaitCard>
  )
}

/** add_project (#1220): what the folder's own machine found there is what is agreed to. No "always": one folder, once */
function ProjectAddCard({
  detail,
  busy,
  keys,
  onAnswer,
}: {
  detail: Extract<ApprovalDetail, { kind: 'project_add' }>
  busy: boolean
  keys: AnswerKeys
  onAnswer: (decision: 'allow' | 'deny') => void
}) {
  const found = !detail.exists ? 'Nothing is there' : detail.folder ? 'A folder that exists' : 'Not a folder'
  return (
    <WaitCard
      testId="approval-card"
      kind="project_add"
      keys={keys === BARE_KEYS ? 'bare' : 'composer'}
      subtitle="The Assistant wants to add a folder as a project, and waits"
    >
      <p className="mt-2 px-3 text-md leading-body text-ink" data-testid="approval-detail">
        Add the folder <span className="readout">{detail.name}</span>
        {detail.machine ? (
          <>
            {' '}
            on{' '}
            <span className="readout" data-testid="approval-machine">
              {detail.machine}
            </span>
          </>
        ) : null}{' '}
        as a project?
      </p>
      <p className="mt-1 break-all px-3 font-mono text-xs leading-body text-ink-muted" data-testid="approval-path">
        {detail.path}
      </p>
      <ul className="mt-1 px-3 text-xs leading-body text-ink" data-testid="approval-facts">
        <li data-testid="approval-found">{found}</li>
        <li data-testid="approval-git">
          {detail.git ? (
            detail.origin ? (
              <>
                A git repository, origin <span className="break-all font-mono">{detail.origin}</span>
              </>
            ) : (
              'A git repository with no origin'
            )
          ) : (
            'Not a git repository'
          )}
        </li>
      </ul>
      <p className="mt-1 px-3 text-xs leading-body text-ink-faint">
        It is added to the sidebar as Add project adds a folder, not trusted until you trust it. Nothing is added unless you
        choose Add.
      </p>
      <WaitFooter>
        <ActionKey k={keys.allow} label="Add" onClick={() => onAnswer('allow')} testId="approve-allow" disabled={busy} />
        <ActionKey k={keys.deny} label="Deny" onClick={() => onAnswer('deny')} testId="approve-deny" disabled={busy} />
      </WaitFooter>
    </WaitCard>
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
 * No "always" for: an edit with no path (#428: "(no path)" never matches, so it would do nothing); a command with no key
 * (#838: empty, flagged by the card, whose text would also pass the plain command, or ending in `*`, a prefix to an older
 * host); a card this window could not read (#844); the Assistant's change to a linked machine, its settings or the
 * archive (#1219); an app tool call (#2231). The last two are asked each time.
 */
export function offersAlways(detail: ApprovalDetail): boolean {
  if (isUnknownCard(detail) || isMachineChange(detail) || isAssistantChange(detail) || isAppCall(detail)) return false
  return (detail.kind !== 'file_edit' && detail.kind !== 'command') || alwaysAllowKey(detail) !== ''
}

export type ApprovalKeyAction = { decision: 'allow' | 'deny' | 'always'; scope?: 'session' | 'project' }

/**
 * Covered, or of an unfocused session: each grid pane's card listens on the window, so one y would approve every card
 * up at once. Keyboard approval goes to the focused session only.
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
 * The project when asked (⌥a, ⌥-click) and the child has one; the Assistant's child has none (#853), so this session.
 * Button and key both ask here, so the toast never promises a project-wide grant the host kept for the session only.
 */
export function agentStartScope(detail: { project: { id: string } }, wantsProject: boolean): 'session' | 'project' {
  return wantsProject && detail.project.id !== '' ? 'project' : 'session'
}

/**
 * When y/n/a answer. ⌘, ⌃ or ⇧ make another shortcut (⌘A, ⌘⇧A next waiting) that must not trigger "always"; only ⌥
 * passes (⌥a, project scope). Nothing while typing in a field or behind a modal or overlay.
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
  // A repeating key is not an approval (#158): held, it would approve the next card before anyone read it
  if (e.repeat || ctx.covered) return null
  // A key an input method is using belongs to the composition, whatever modifiers it carries (app/keys.ts)
  if (composingKey({ key: e.key, isComposing: !!e.isComposing, keyCode: e.keyCode ?? 0 })) return null
  const combo = approvalComboOf(e)
  if (combo) return ctx.inComposer || !ctx.typing ? combo : null
  if (e.metaKey || e.ctrlKey || e.shiftKey) return null
  if (ctx.typing) return null
  // By meaning, not keycap: ⌥ or a Korean layout changes `key` (app/keys.ts)
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
const APPROVAL_COMBOS = {
  allow: ['mod', '⇧Y'],
  deny: ['mod', '⇧D'],
  always: ['mod', '⇧L'],
} as const

/**
 * Exactly these modifiers, chosen to take no key that means something already (docs/product-spec.md "FR-3"). Also taken:
 * bare mod+letters (⌘N/W/M/H/Q, mod+K/I/B, mod+1-9), mod+⇧N/⇧F (#529), WebView2's mod+⇧I/J/C/R (devtools, hard reload).
 * L, for "always", is off the keys a hand reaches for by habit; project scope stays on ⌥a and ⌥-click.
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

/** The session whose composer holds the keyboard, if any */
function composerOf(target: EventTarget | null): string | null {
  const el = target as HTMLElement | null
  return el?.dataset?.composerSession ?? null
}

/** Follows the keyboard into and out of a session's composer, for the hints on its card */
function useComposerFocused(sessionId: string): boolean {
  const [focused, setFocused] = useState(
    () => composerOf(typeof document === 'undefined' ? null : document.activeElement) === sessionId,
  )
  useEffect(() => {
    // In a microtask: focusin from a layout effect fires inside React's commit, where a state update warns (flushSync
    // from a lifecycle); activeElement is settled by then too.
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
 * Also a list row's tooltip (#543). `approvalNotes` stand under the command or path, so nothing the agent asked for is
 * only in the row's head (#683).
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
