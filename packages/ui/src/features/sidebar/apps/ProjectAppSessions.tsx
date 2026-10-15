import { useState } from 'react'
import type { SessionSummary } from '@cc/core'
import { treeRows } from '../tree.js'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { handoffBlockedBy, useStore } from '../../../store/store.js'
import { BackgroundMark } from '../../session/BackgroundTasks.jsx'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { DotsIcon } from '../../../components/icons.jsx'
import { groupAttention } from '../fold.js'
import { ROW_MENU_PAD, ROW_PAD } from '../layout.js'
import { GroupToggle } from '../rows/GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from '../rows/groupFold.js'
import { SessionRow, approvalLine } from '../rows/SessionRow.jsx'
import { SessionNameInput } from '../rows/SessionNameInput.jsx'
import { ConfirmHandoff } from '../dialogs/ConfirmHandoff.jsx'
import { ConfirmDelete } from '../dialogs/ConfirmDelete.jsx'
import { SessionMenu } from '../menus/SessionMenu.jsx'
import { ToolMark } from '../marks/ToolMark.jsx'

/** A listed project app owns these rows, so they cannot be reordered into the project's session list. */
export function ProjectAppSessions({ sessions, projectId, folded }: { sessions: SessionSummary[]; projectId: string; folded: boolean }) {
  const selected = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const renameSession = useStore((s) => s.rename)
  const deleteSession = useStore((s) => s.deleteSession)
  const handoffSession = useStore((s) => s.handoffSession)
  const defaultTool = useStore((s) => s.projects[projectId]?.defaultTool ?? '')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [handingOff, setHandingOff] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const foldedGroups = useStore((s) => s.prefs.foldedGroups)
  const setGroupsFolded = useStore((s) => s.setGroupsFolded)
  return (
    <>
      {/* The app's group folded away leaves the dialogs of a row that was open (rename, delete) where they are */}
      {(folded ? [] : treeRows(sessions, (id) => foldedGroups.includes(childrenGroupKey(id)))).map(({ s, nested, children, folded: childrenFolded }) => {
    const focused = selected === s.id
    const unread = s.lastSeq > s.lastReadSeq
    const groupKey = childrenGroupKey(s.id)
    return (
      <SessionRow
        key={s.id}
        id={s.id}
        projectId={projectId}
        nested={nested ? 2 : 1}
        level={nested ? 3 : 2}
        below={approvalLine(s, renaming, () => focusSession(s.id))}
        draggable={renaming !== s.id && !nested}
        onReorder={() => {}}
      >
        {renaming === s.id ? (
          <SessionNameInput
            id={s.id}
            initial={s.name}
            onDone={(name) => {
              setRenaming(null)
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
              onClick={() => focusSession(s.id)}
              onKeyDown={foldKeys(children.length > 0, childrenFolded, (next) => setGroupsFolded([groupKey], next))}
              onDoubleClick={() => setRenaming(s.id)}
              data-testid={`app-session-row-${s.id}`}
              aria-current={focused ? 'page' : undefined}
              data-unread={(unread && !focused) || undefined}
              className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} ${ROW_MENU_PAD} text-left text-md transition-colors ${
                focused
                  ? 'border-l-ink-muted bg-surface-hover/40 text-ink'
                  : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
              }`}
            >
              <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !s.unreachable} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} />
              <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
              {childrenFolded && (
                <FoldedMark count={children.length} attention={groupAttention(children)} testId={`children-folded-${s.id}`} />
              )}
              {s.merged && <span className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint" data-testid={`merged-badge-${s.id}`}>merged</span>}
              {s.pr && !s.merged && <span className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint" data-testid={`pr-badge-${s.id}`} title={`Pull request #${s.pr.number} — ${s.pr.state}\n${s.pr.url}`}>PR #{s.pr.number}{s.pr.state === 'closed' ? ' ✕' : ''}</span>}
              <BackgroundMark tasks={s.backgroundTasks} testId={`background-mark-${s.id}`} />
            </button>
            <span
              className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
                sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
              }`}
              data-testid={`session-actions-${s.id}`}
            >
              <button
                type="button"
                aria-label={`Actions for ${s.name}`}
                onClick={(e) => {
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
      })}
      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === confirming)?.tool ?? defaultTool}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}
      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? defaultTool}
          dead={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? s.state === 'error' || !!s.limit : false
          })()}
          blocked={(() => {
            const s = sessions.find((x) => x.id === handingOff)
            return s ? handoffBlockedBy(s) : null
          })()}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld, mode) => {
            void handoffSession(handingOff, { tool, deleteOld, mode })
            setHandingOff(null)
          }}
        />
      )}
    </>
  )
}
