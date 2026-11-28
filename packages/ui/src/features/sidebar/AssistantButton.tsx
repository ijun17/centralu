import { isAssistantKind } from '@cc/protocol/client'
import { useMemo, useState } from 'react'
import { isInTurn, isMirrored, isUnread, type SessionSummary } from '@cc/core'
import { useStore, type AppState } from '../../store/store.js'
import { useSelectedSessionId } from '../../store/selectors.js'
import { INDENT, GUIDE } from './layout.js'
import { ToolMark } from './marks/ToolMark.jsx'
import { RowMenu } from './menus/RowMenu.jsx'
import { ActionRow } from './menus/ActionRow.jsx'
import { ConfirmDelete } from './dialogs/ConfirmDelete.jsx'
import { CrownIcon, DotsIcon } from '../../components/icons.jsx'
import { SESSION_MIME } from './reorder.js'
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

  // pt-1.5, the grid's own gap: the search field stands above it (#529) and takes the lane's top margin
  return (
    <div className="px-2 pt-1.5">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          active
            ? 'border-line-strong bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        }`}
        // The same rule as the grid: a selection, not a toggle. To leave, choose something else
        onClick={() => void open()}
        /*
          Draggable once its session exists (opening a screen never creates a process, #63); the grid takes its id as
          any session row's.
        */
        draggable={!!id}
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
      <AssistantChildren assistantId={id} view={view} />
    </div>
  )
}

/**
 * The sessions the Assistant started with start_agent (#853), on this machine, with no project to hang in. `earlier`:
 * those whose assistant is gone (#994); nothing else starts a session with no project and no app.
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

/** The children's list is drawn while the Assistant page is open or while one of its children is the open session; no folded count */
export function assistantListShown(
  view: AppState['view'],
  selectedId: string | null,
  children: { current: readonly { id: string }[]; earlier: readonly { id: string }[] },
): boolean {
  return view === 'assistant' || (selectedId !== null && [...children.current, ...children.earlier].some((s) => s.id === selectedId))
}

function AssistantChildren({ assistantId, view }: { assistantId: string | null; view: AppState['view'] }) {
  const all = useStore((s) => s.sessions)
  const selected = useSelectedSessionId()
  const { current, earlier } = useMemo(() => assistantChildren(all, assistantId), [all, assistantId])
  const shown = assistantListShown(view, selected, { current, earlier })
  // The archive dialog lives here, not in a row: the host's answer (#1512) can arrive after switching views
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const deleteSession = useStore((st) => st.deleteSession)
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
  const row = (s: SessionSummary) => <AssistantChildRow key={s.id} s={s} setConfirming={(on) => setConfirmingId(on ? s.id : null)} />
  return (
    <>
      {/* Slides like a project's rows (#1605) */}
      <Fold open={shown} className={current.length > 0 || earlier.length > 0 ? 'pt-0.5' : undefined} testId="assistant-fold">
        <ul data-testid="assistant-children">
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
 * One child's row, with a ⋯ menu to stop or archive it (#994): no project list holds it. No fold gutter: it folds
 * nothing, and an empty column would push its mark from the guide line.
 */
function AssistantChildRow({ s, setConfirming }: { s: SessionSummary; setConfirming: (on: boolean) => void }) {
  const selected = useSelectedSessionId()
  const focusSession = useStore((st) => st.focusSession)
  const interrupt = useStore((st) => st.interrupt)
  const machines = useStore((st) => st.machines)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
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
