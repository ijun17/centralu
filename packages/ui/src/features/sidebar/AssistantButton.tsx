import { isAssistantKind } from '@cc/protocol/client'
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
 * The door to the Assistant, directing by talking: beside the grid, the other way of looking at the sessions, and under
 * no project, as crossing projects is what it is for.
 */
export function AssistantButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openAssistant)
  const id = useStore((s) => s.assistantId)
  const active = view === 'assistant'
  // The children open while the mouse rests on the button (#1591), as a folded project's rows do (#1578); a click pins nothing
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

  // pt-1.5, the grid's own gap: the search field stands above it (#529) and takes the lane's top margin
  return (
    <div
      className="px-2 pt-1.5"
      ref={blockRef}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') expander.leaveBlock()
      }}
    >
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          active
            ? 'border-line-strong bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        }`}
        // The same rule as the grid: a selection, not a toggle. To leave, choose something else
        onClick={() => {
          // Pressing the button before the rest is over is a decision not to wait for it (as a press on a folded project's row is, #1578)
          expander.leaveRow()
          void open()
        }}
        /*
          Draggable once its session exists (opening a screen never creates a process, #63); the grid takes its id as
          any session row's.
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
        data-testid="assistant-button"
        title={
          id
            ? 'One conversation that directs your sessions. Drag it to Grid to watch it beside other sessions.'
            : 'One conversation that directs your sessions.'
        }
      >
        <CrownIcon />
        <span className="truncate font-medium tracking-tight">Assistant</span>
      </button>
      <AssistantChildren assistantId={id} hoverOpen={hoverOpen} onHold={onHold} onDragging={setDragging} />
    </div>
  )
}

/**
 * The sessions the Assistant started with start_agent (#853), on this machine, with no project to hang in. `earlier`:
 * those whose assistant is gone (#994 review); nothing else starts a session with no project and no app.
 */
export function assistantChildren(
  sessions: Record<string, SessionSummary>,
  assistantId: string | null,
): { current: SessionSummary[]; earlier: SessionSummary[] } {
  // The store learns `assistantId` when the screen opens; the listed row says it from the start
  const assistants = new Set(Object.values(sessions).filter((s) => isAssistantKind(s.kind) && !s.machine).map((s) => s.id))
  if (assistantId) assistants.add(assistantId)
  const started = Object.values(sessions).filter((s) => !s.projectId && !s.appId && !s.machine && !isAssistantKind(s.kind) && !!s.askedBy)
  return {
    current: started.filter((s) => assistants.has(s.askedBy!)),
    earlier: started.filter((s) => !assistants.has(s.askedBy!) && !sessions[s.askedBy!]),
  }
}

/** The children's list is drawn while hovered (#1591) or while one of them is the open session; no folded count */
export function assistantListShown(hoverOpen: boolean, selectedId: string | null, children: { current: readonly { id: string }[]; earlier: readonly { id: string }[] }): boolean {
  return hoverOpen || (selectedId !== null && [...children.current, ...children.earlier].some((s) => s.id === selectedId))
}

function AssistantChildren({
  assistantId,
  hoverOpen,
  onHold,
  onDragging,
}: {
  assistantId: string | null
  hoverOpen: boolean
  onHold: (rowId: string, held: boolean) => void
  onDragging: (dragging: boolean) => void
}) {
  const all = useStore((s) => s.sessions)
  const selected = useSelectedSessionId()
  const { current, earlier } = useMemo(() => assistantChildren(all, assistantId), [all, assistantId])
  const shown = assistantListShown(hoverOpen, selected, { current, earlier })
  // A row dragged away from a list that then goes is never told its drag ended
  useEffect(() => {
    if (!shown) onDragging(false)
  }, [shown, onDragging])
  // The archive dialog lives here, not in a row: the host's answer (#1512) can come after a hover-opened list folded
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
  const row = (s: SessionSummary) => <AssistantChildRow key={s.id} s={s} onHold={onHold} setConfirming={(on) => setConfirmingId(on ? s.id : null)} />
  return (
    <>
      {/* Slides like a project's rows (#1605) */}
      <Fold open={shown} className={current.length > 0 || earlier.length > 0 ? 'pt-0.5' : undefined} testId="assistant-fold">
        <ul data-testid="assistant-children" onDragStart={() => onDragging(true)} onDragEnd={() => onDragging(false)}>
          {current.map(row)}
          {earlier.length > 0 && (
            <>
              <li className={`${INDENT[2]} pt-1 text-2xs text-ink-faint`} data-testid="assistant-children-earlier">
                Started by an earlier assistant
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
 * One child's row, with a ⋯ menu to stop or archive it (#994 review): no project list holds it. No fold gutter: it folds
 * nothing, and an empty column would push its mark from the guide line.
 */
function AssistantChildRow({ s, onHold, setConfirming }: { s: SessionSummary; onHold: (rowId: string, held: boolean) => void; setConfirming: (on: boolean) => void }) {
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
        data-testid={`assistant-child-row-${s.id}`}
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
