import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isInTurn, isMirrored, isUnread, type SessionSummary } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useSelectedSessionId } from '../../store/selectors.js'
import { INDENT, GUIDE } from './layout.js'
import { ToolMark } from './marks/ToolMark.jsx'
import { RowMenu } from './menus/RowMenu.jsx'
import { ActionRow } from './menus/ActionRow.jsx'
import { ConfirmDelete } from './dialogs/ConfirmDelete.jsx'
import { CrownIcon, DotsIcon } from '../../components/icons.jsx'
import { SESSION_MIME } from './reorder.js'
import { HoverExpander } from './fold.js'
import { Fold } from '../../components/Fold.jsx'

/**
 * The door to the orchestrator — **directing by talking**.
 *
 * Placed directly above the grid. The two are two ways of looking at the same thing, so they
 * should stand side by side:
 *   orchestrator  direct sessions by talking, in one window
 *   grid          watch several windows at a glance
 *
 * Not nested under a project. This session does not belong to any project — crossing multiple
 * projects is the whole reason it exists.
 *
 * **The button spells out that it is still experimental** (issue #1). It looks identical to the
 * grid button, and people pressed it without knowing the difference. Putting the label **inside**
 * the orchestrator screen would be too late — the person has already pressed it by then, and the
 * harm being prevented is exactly "pressing it without knowing."
 *
 * Follows the palette rule (styles/index.css) as is: **urgency is brightness, kind is shape.**
 * The text is ink-faint (the color reserved for background information). Making it brighter would be
 * a lie that it is more urgent than the grid button — "experimental" is not urgent, it is
 * **something the person should press knowingly.**
 *
 * The border used to be dashed. The reasoning was "when the sidebar narrows, the text gets
 * clipped away and only the shape is left," but **measuring it showed that was not true.** The
 * 'Experimental' badge is `shrink-0`, so it stands at its full 63px even at the narrowest width
 * (180px, with the button at 163px) — what gets clipped instead is the name. Since there was
 * nothing the dashed border was protecting, there was no reason for it to stay either.
 */
export function OrchestratorButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openOrchestrator)
  const id = useStore((s) => s.orchestratorId)
  const active = view === 'orchestrator'
  /*
   * The children fold under the button and open when the mouse rests on it (#1591), by the rule of a folded project's name
   * (#1578): a transient state that nothing saves. Leaving the whole block, button and list, folds it again. A click on
   * the button only opens the screen; it pins nothing.
   */
  const [hoverOpen, setHoverOpen] = useState(false)
  const blockRef = useRef<HTMLDivElement>(null)
  const expander = useMemo(
    () => new HoverExpander({ onChange: setHoverOpen, pointerInside: () => !!blockRef.current?.matches(':hover') }),
    [],
  )
  // A row menu, the archive dialog or a drag from a row keeps the list as it is until it ends
  const [holders, setHolders] = useState<ReadonlySet<string>>(new Set())
  const [dragging, setDragging] = useState(false)
  const onHold = useCallback(
    (rowId: string, held: boolean) =>
      setHolders((cur) => {
        if (cur.has(rowId) === held) return cur
        const next = new Set(cur)
        if (held) next.add(rowId)
        else next.delete(rowId)
        return next
      }),
    [],
  )
  const holding = holders.size > 0 || dragging
  useEffect(() => expander.hold(holding), [expander, holding])
  useEffect(() => () => expander.reset(), [expander])

  // pt-2: the lane's top margin. Search used to stand above this row (#529); it moved to the top bar (#727)
  return (
    <div
      className="px-2 pt-2"
      ref={blockRef}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') expander.leaveBlock()
      }}
    >
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          active
            ? 'border-ink-faint/50 bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        }`}
        // The same rule as the grid: a selection, not a toggle. To leave, choose something else
        onClick={() => {
          // Pressing the button before the rest is over is a decision not to wait for it (as a press on a folded project's row is, #1578)
          expander.leaveRow()
          void open()
        }}
        /*
          The orchestrator is a session too. Before the first conversation, no session exists yet,
          so it is not made draggable — that keeps the #63 rule that opening a screen alone never
          creates a process. Once a conversation exists, it can be dragged into the grid like any
          other session row. The side that receives an ID into GridView was already shared code;
          this was the only entry point still missing from it.
        */
        draggable={!!id}
        onPointerEnter={(e) => e.pointerType === 'mouse' && expander.enterRow(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && expander.leaveRow()}
        onDragStart={(e) => {
          if (!id) return
          e.dataTransfer.setData(SESSION_MIME, id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        aria-pressed={active}
        data-testid="orchestrator-button"
        title={
          id
            ? 'One conversation that directs your sessions. Drag it to Grid to watch it beside other sessions.'
            : 'One conversation that directs your sessions.'
        }
      >
        <CrownIcon />
        <span className="truncate font-medium tracking-tight">Orchestrator</span>
      </button>
      <OrchestratorChildren orchestratorId={id} hoverOpen={hoverOpen} onHold={onHold} onDragging={setDragging} />
    </div>
  )
}

/**
 * The sessions the orchestrator started with start_agent (#853): no project and no app, asked by the orchestrator, on
 * this machine. A child of a project session hangs under it in its project; these have no project to hang in, so they
 * hang here, where the person watches and steps into them like any session.
 *
 * `earlier`: ones whose orchestrator is gone (replaced on a tool switch, #994 review). Nothing else starts a session with
 * no project and no app, so a missing starter was an orchestrator; without this group they had no row at all.
 */
export function orchestratorChildren(
  sessions: Record<string, SessionSummary>,
  orchestratorId: string | null,
): { current: SessionSummary[]; earlier: SessionSummary[] } {
  // The store learns `orchestratorId` when the screen opens; the listed row says it from the start
  const orchestrators = new Set(Object.values(sessions).filter((s) => s.kind === 'orchestrator' && !s.machine).map((s) => s.id))
  if (orchestratorId) orchestrators.add(orchestratorId)
  const started = Object.values(sessions).filter((s) => !s.projectId && !s.appId && !s.machine && s.kind !== 'orchestrator' && !!s.askedBy)
  return {
    current: started.filter((s) => orchestrators.has(s.askedBy!)),
    earlier: started.filter((s) => !orchestrators.has(s.askedBy!) && !sessions[s.askedBy!]),
  }
}

/**
 * Whether the children's list is drawn (#1591): while the mouse rests on the button (`hoverOpen`), and always while one
 * of the children is the open session, so the open session's row does not vanish. Nothing else says it is folded: no count.
 */
export function orchestratorListShown(hoverOpen: boolean, selectedId: string | null, children: { current: readonly { id: string }[]; earlier: readonly { id: string }[] }): boolean {
  return hoverOpen || (selectedId !== null && [...children.current, ...children.earlier].some((s) => s.id === selectedId))
}

function OrchestratorChildren({
  orchestratorId,
  hoverOpen,
  onHold,
  onDragging,
}: {
  orchestratorId: string | null
  hoverOpen: boolean
  onHold: (rowId: string, held: boolean) => void
  onDragging: (dragging: boolean) => void
}) {
  const all = useStore((s) => s.sessions)
  const selected = useSelectedSessionId()
  const { current, earlier } = useMemo(() => orchestratorChildren(all, orchestratorId), [all, orchestratorId])
  const shown = orchestratorListShown(hoverOpen, selected, { current, earlier })
  // A row dragged away from a list that then goes is never told its drag ended
  useEffect(() => {
    if (!shown) onDragging(false)
  }, [shown, onDragging])
  /*
   * The archive dialog is kept here, not in a row: archiving closes the row's menu at once and the host's answer (it asks
   * first when something would be lost, #1512) comes later, and a list opened by hover may have folded by then. A row
   * that is gone still reaches `setConfirmingId`, and the dialog stands on its own.
   */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const deleteSession = useStore((st) => st.deleteSession)
  useEffect(() => {
    onHold('archive-dialog', confirmingId !== null)
    return () => onHold('archive-dialog', false)
  }, [onHold, confirmingId])
  const confirming = confirmingId === null ? undefined : [...current, ...earlier].find((c) => c.id === confirmingId)
  const dialog = confirming && (
    <ConfirmDelete
      sessionId={confirming.id}
      name={confirming.name}
      tool={confirming.tool}
      onCancel={() => setConfirmingId(null)}
      onDone={() => setConfirmingId(null)}
      onConfirm={(deleteWorktree, deleteExternal) => {
        void deleteSession(confirming.id, deleteWorktree, deleteExternal)
        setConfirmingId(null)
      }}
    />
  )
  const row = (s: SessionSummary) => <OrchestratorChildRow key={s.id} s={s} onHold={onHold} setConfirming={(on) => setConfirmingId(on ? s.id : null)} />
  return (
    <>
      {/* Slides open and closed like a project's rows (#1605); the rows stay until the exit ends. A child that arrives while it is open does not slide */}
      <Fold open={shown} className={current.length > 0 || earlier.length > 0 ? 'pt-0.5' : undefined} testId="orchestrator-fold">
        <ul data-testid="orchestrator-children" onDragStart={() => onDragging(true)} onDragEnd={() => onDragging(false)}>
          {current.map(row)}
          {earlier.length > 0 && (
            <>
              <li className={`${INDENT[2]} pt-1 text-2xs text-ink-faint`} data-testid="orchestrator-children-earlier">
                Started by an earlier orchestrator
              </li>
              {earlier.map(row)}
            </>
          )}
        </ul>
      </Fold>
      {dialog}
    </>
  )
}

/**
 * One child's row: opens it, drags onto the grid, and carries a ⋯ menu to stop or delete it (#994 review): the delete
 * dialog lived only in a project's list, so a child of the orchestrator could not be removed from the screen.
 */
// No fold gutter on these rows (owner, 2026-10-20): an orchestrator's child folds nothing, so the chevron's empty
// column only pushed its mark away from the guide line
function OrchestratorChildRow({ s, onHold, setConfirming }: { s: SessionSummary; onHold: (rowId: string, held: boolean) => void; setConfirming: (on: boolean) => void }) {
  const selected = useSelectedSessionId()
  const focusSession = useStore((st) => st.focusSession)
  const interrupt = useStore((st) => st.interrupt)
  const machines = useStore((st) => st.machines)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  // An open menu or dialog keeps the list shown while the pointer is away (#1591)
  const holding = menu !== null
  useEffect(() => {
    onHold(s.id, holding)
    return () => onHold(s.id, false)
  }, [onHold, s.id, holding])
  const focused = selected === s.id
  const unread = isUnread(s)
  return (
    <li
      data-level={2}
      className={`group/row relative ${INDENT[2]} ${GUIDE}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, s.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <button
        type="button"
        onClick={() => focusSession(s.id)}
        data-testid={`orchestrator-child-row-${s.id}`}
        aria-current={focused ? 'page' : undefined}
        data-unread={(unread && !focused) || undefined}
        className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2 pr-8 text-left text-md transition-colors ${
          focused ? 'border-l-ink-muted bg-surface-hover/40 text-ink' : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
        }`}
      >
        <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !isMirrored(s, machines)} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} unread={isUnread(s)} />
        <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
      </button>
      <span
        className={`absolute right-3 top-1.5 flex items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${menu ? 'opacity-100' : 'opacity-0'}`}
      >
        <button
          type="button"
          aria-label={`Actions for ${s.name}`}
          onClick={(e) => {
            const el = e.currentTarget
            setMenu((cur) => (cur ? null : el))
          }}
          data-testid={`session-menu-${s.id}`}
          className="flex items-center justify-center rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
        >
          <DotsIcon size={14} />
        </button>
      </span>
      {menu && (
        <RowMenu anchorEl={menu} testId={`session-menu-open-${s.id}`} onClose={() => setMenu(null)}>
          {isInTurn(s.state) && (
            <ActionRow
              label="Stop"
              onClick={() => {
                setMenu(null)
                void interrupt(s.id)
              }}
              testId={`stop-session-${s.id}`}
            />
          )}
          <ActionRow
            label="Archive session…"
            onClick={() => {
              setMenu(null)
              setConfirming(true)
            }}
            testId={`delete-session-${s.id}`}
            danger
          />
        </RowMenu>
      )}
    </li>
  )
}
