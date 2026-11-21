import { memo, type Dispatch, type SetStateAction } from 'react'
import { isMirrored, isUnread } from '@cc/core'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import { DotsIcon } from '../../../components/icons.jsx'
import { groupAttention } from '../fold.js'
import { MAX_LEVEL, ROW_MENU_PAD, ROW_PAD, type INDENT } from '../layout.js'
import { GroupToggle } from './GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from './groupFold.js'
import { SessionRow } from './SessionRow.jsx'
import { SessionNameInput } from './SessionNameInput.jsx'
import { SessionMenu } from '../menus/SessionMenu.jsx'
import { ToolMark } from '../marks/ToolMark.jsx'
import type { TreeRow } from '../tree.js'

/**
 * One session's row in a project's list or under one of its apps (`inApp`). Redrawn only when its session, children or
 * a prop changed (`sameRow`): the list is rebuilt on every streamed piece of any session, and redrawing every row was
 * most of what the window allocated while sessions worked out of view. So callers pass stable functions.
 */
export const SessionListRow = memo(SessionListRowView, sameRow)

type Props = Parameters<typeof SessionListRowView>[0]

/** The tree is built anew each time; a row is the same when what it holds is the same objects */
function sameRow(a: Props, b: Props): boolean {
  // Every other prop the same value, in any order, without building anything: this runs for every row on every list draw
  for (const k in a) if (k !== 'row' && !Object.is(Reflect.get(a, k), Reflect.get(b, k))) return false
  for (const k in b) if (!(k in a)) return false
  const x = a.row
  const y = b.row
  if (x.s !== y.s || x.nested !== y.nested || x.depth !== y.depth || x.folded !== y.folded) return false
  if (x.children.length !== y.children.length) return false
  for (let i = 0; i < x.children.length; i++) if (x.children[i] !== y.children[i]) return false
  return true
}

function SessionListRowView({
  row: { s, nested, depth, children, folded: childrenFolded },
  projectId,
  inApp = false,
  onReorder,
  focusedSessionId,
  renaming,
  setRenaming,
  sessionMenu,
  setSessionMenu,
  setHandingOff,
  setConfirming,
}: {
  row: TreeRow
  projectId: string
  /** The row hangs under a listed app of the project, not directly under the project */
  inApp?: boolean
  /** Another session row was dropped on the row `rowId`: `before` says which edge */
  onReorder: (rowId: string, draggedId: string, before: boolean) => void
  focusedSessionId: string | null
  renaming: string | null
  setRenaming: (id: string | null) => void
  sessionMenu: { id: string; el: HTMLElement } | null
  setSessionMenu: Dispatch<SetStateAction<{ id: string; el: HTMLElement } | null>>
  setHandingOff: (id: string | null) => void
  setConfirming: (id: string | null) => void
}) {
  const focusSession = useStore((s) => s.focusSession)
  const renameSession = useStore((s) => s.rename)
  const setGroupsFolded = useStore((s) => s.setGroupsFolded)
  const machines = useStore((s) => s.machines)
  const unread = isUnread(s)
  const focused = focusedSessionId === s.id
  const groupKey = childrenGroupKey(s.id)
  return (
    <SessionRow
      id={s.id}
      projectId={projectId}
      nested={inApp ? depth + 1 : nested}
      level={Math.min((inApp ? 2 : 1) + depth, MAX_LEVEL) as keyof typeof INDENT}
      // A child row is not draggable: its position states membership (#69), which a drag would not change
      draggable={renaming !== s.id && !nested}
      onReorder={(draggedId, before) => onReorder(s.id, draggedId, before)}
    >
      {renaming === s.id ? (
        <SessionNameInput
          id={s.id}
          initial={s.name}
          onDone={(name) => {
            setRenaming(null)
            // An unchanged name makes no round trip (nor a failure toast)
            if (name && name !== s.name) void renameSession(s.id, name)
          }}
        />
      ) : (
        <>
          {children.length > 0 && (
            <GroupToggle
              folded={childrenFolded}
              label={`${childrenFolded ? 'Show' : 'Hide'} the ${children.length === 1 ? 'session' : `${children.length} sessions`} ${s.name} started`}
              testId={`children-fold-${s.id}`}
              onToggle={() => setGroupsFolded([groupKey], !childrenFolded)}
            />
          )}
          <button
            // Opening a row of a hover-expanded project leaves the saved fold as it is (#1578): it folds when the pointer leaves
            onClick={(e) => focusSession(s.id, e.currentTarget.closest('[data-hover-expanded]') ? { reveal: false } : undefined)}
            onKeyDown={foldKeys(children.length > 0, childrenFolded, (next) => setGroupsFolded([groupKey], next))}
            // Double-click renames, as in file explorers; the menu's Rename is the way for whoever does not know that
            onDoubleClick={() => setRenaming(s.id)}
            data-testid={`${inApp ? 'app-session-row' : 'session-row'}-${s.id}`}
            // The same word an app row and the project's name row use
            aria-current={focused ? 'page' : undefined}
            // Unread (FR-16) is the name's brightness; the attribute lets tests see it without asserting a class
            data-unread={(unread && !focused) || undefined}
            // ROW_MENU_PAD clears the hover menu button: a name hidden under it is worse than truncated
            className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} ${ROW_MENU_PAD} text-left text-md transition-colors ${
              focused
                ? 'border-l-ink-muted bg-surface-hover/40 text-ink'
                : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
            }`}
          >
            {/*
              One mark: the letter is the tool, the border the state
            */}
            <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !isMirrored(s, machines)} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} unread={isUnread(s)} background={{ tasks: s.backgroundTasks, testId: `background-mark-${s.id}` }} />
            <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
            {childrenFolded && (
              <FoldedMark count={children.length} attention={groupAttention(children)} testId={`children-folded-${s.id}`} />
            )}
            {/*
              Merged (#69): cleaned up by the person or its starter (agent_session delete, #561)
            */}
            {s.merged && (
              <span
                className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
                data-testid={`merged-badge-${s.id}`}
                title="Branch merged into the trunk — safe to clean up from the delete dialog"
              >
                merged
              </span>
            )}
            {/*
              The branch's PR, read through gh (#76 stage 3); not beside merged, which says the same
            */}
            {s.pr && !s.merged && (
              <span
                className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
                data-testid={`pr-badge-${s.id}`}
                title={`Pull request #${s.pr.number} — ${s.pr.state}\n${s.pr.url}`}
              >
                #{s.pr.number}
                {s.pr.state === 'closed' ? ' ✕' : ''}
              </span>
            )}
            {/*
              Background work (#290) is the mark's dot
            */}
            {/*
              No unread dot: the mark and the name's brightness already say it
            */}
          </button>
          {/*
            One labeled menu, not icons (SessionMenu)
          */}
          {/*
            right-3 matches the project header's px-3: the two ⋯ buttons share a column
          */}
          <span
            className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
              sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
            }`}
            data-testid={`session-actions-${s.id}`}
          >
            {/* No tooltip, as the project's ⋯ */}
            <button
              type="button"
              aria-label={`Actions for ${s.name}`}
              onClick={(e) => {
                // Read now: React clears currentTarget once the handler returns
                const el = e.currentTarget
                setSessionMenu((cur) => (cur?.id === s.id ? null : { id: s.id, el }))
              }}
              data-testid={`session-menu-${s.id}`}
              className="flex items-center justify-center rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover/60 hover:text-ink"
            >
              <DotsIcon size={14} />
            </button>
          </span>
          {sessionMenu?.id === s.id && (
            <SessionMenu
              session={s}
              anchorEl={sessionMenu.el}
              onClose={() => setSessionMenu(null)}
              onRename={() => setRenaming(s.id)}
              onHandoff={() => setHandingOff(s.id)}
              onDelete={() => setConfirming(s.id)}
            />
          )}
        </>
      )}
    </SessionRow>
  )
}
