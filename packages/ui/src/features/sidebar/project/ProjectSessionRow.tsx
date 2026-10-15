import type { Dispatch, SetStateAction } from 'react'
import type { SessionSummary } from '@cc/core'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import { BackgroundMark } from '../../session/BackgroundTasks.jsx'
import { DotsIcon } from '../../../components/icons.jsx'
import { moveTo } from '../reorder.js'
import { groupAttention } from '../fold.js'
import { ROW_MENU_PAD, ROW_PAD } from '../layout.js'
import { GroupToggle } from '../rows/GroupToggle.jsx'
import { FoldedMark } from '../marks/FoldedMark.jsx'
import { foldKeys } from '../rows/groupFold.js'
import { SessionRow, approvalLine } from '../rows/SessionRow.jsx'
import { SessionNameInput } from '../rows/SessionNameInput.jsx'
import { SessionMenu } from '../menus/SessionMenu.jsx'
import { ToolMark } from '../marks/ToolMark.jsx'
import type { TreeRow } from '../tree.js'

export function ProjectSessionRow({
  row: { s, nested, children, folded: childrenFolded },
  projectId,
  sessions,
  byApp,
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
  /** The project's sessions in list order: what a drop reorders */
  sessions: SessionSummary[]
  /** The sessions listed apps own, which cannot be reordered into the project's list */
  byApp: Map<string, SessionSummary[]>
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
  const reorderSessions = useStore((s) => s.reorderSessions)
  const setGroupsFolded = useStore((s) => s.setGroupsFolded)
  const unread = s.lastSeq > s.lastReadSeq
  const focused = focusedSessionId === s.id
  const groupKey = childrenGroupKey(s.id)
  return (
    <SessionRow
      id={s.id}
      projectId={projectId}
      nested={nested}
      level={nested ? 2 : 1}
      below={approvalLine(s, renaming, () => focusSession(s.id))}
      /*
       * A child row cannot be dragged — position is membership (#69). Letting a row
       * drawn indented under a parent be moved by hand would make the new position read
       * as membership, while the actual membership (parentSessionId) stays unchanged,
       * and the screen would end up lying.
       */
      draggable={renaming !== s.id && !nested}
      onReorder={(draggedId, before) => {
        // App-owned rows can still be dropped on the grid, but their appId — not list position — is their membership.
        if (
          [...byApp.values()].some((owned) =>
            owned.some((session) => session.id === draggedId),
          )
        )
          return
        void reorderSessions(
          projectId,
          moveTo(
            sessions.map((x) => x.id),
            draggedId,
            s.id,
            before,
          ),
        )
      }}
    >
      {renaming === s.id ? (
        <SessionNameInput
          id={s.id}
          initial={s.name}
          onDone={(name) => {
            setRenaming(null)
            // No reason for a round trip when the name is unchanged (and no reason for a failure toast either)
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
            /*
              Double-clicking the name edits it in place — the same convention as file
              explorers and tab names, so the hand knows it before the person even finds
              the button. The pencil button is a second entry point for a person who does
              not know that convention: keeping only one of the two would leave half the
              people unable to rename anything.
            */
            onDoubleClick={() => setRenaming(s.id)}
            data-testid={`session-row-${s.id}`}
            // The open row inside the tinted group — the same word an app row and the project's name row use
            aria-current={focused ? 'page' : undefined}
            /*
              Unread (FR-16) is stated by the name's brightness (the text-ink on the
              truncate span below). It is also kept as an attribute so a test can see a
              fact not otherwise present on screen — asserting a class name would break
              the test every time the color gets adjusted.
            */
            data-unread={(unread && !focused) || undefined}
            /*
              The right padding has to clear the menu button that appears on hover
              (ROW_MENU_PAD): a long name that ran in underneath it would be text hidden
              under a button, which is worse than text truncated.
            */
            className={`flex w-full items-center gap-2 border-l-2 py-1.5 ${ROW_PAD} ${ROW_MENU_PAD} text-left text-md transition-colors ${
              focused
                ? 'border-l-ink-muted bg-surface-hover/40 text-ink'
                : 'border-l-transparent text-ink-muted hover:bg-surface-hover/20 hover:text-ink'
            }`}
          >
            {/*
              One mark states two things: the letter is the tool, the border is the
              state. A separate dot right next to the mark would read as overlapping the
              two, and blur both instead.
            */}
            <ToolMark tool={s.tool} state={s.state} asleep={!s.live && !s.unreachable} interruption={s.interruption ?? null} openQuestions={s.pendingQuestions.length} />
            <span className={`truncate ${unread && !focused ? 'text-ink' : ''}`}>{s.name}</span>
            {childrenFolded && (
              <FoldedMark count={children.length} attention={groupAttention(children)} testId={`children-folded-${s.id}`} />
            )}
            {/*
              Merged (#69) — this branch's work has landed on the trunk. A sign that it
              is history, not ongoing work. Cleaning it up is the person's, in the delete
              dialog, or the session that started it (agent_session delete, #561).
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
              The PR chip (#76 stage 3) — this branch's pull request, measured through
              gh. Not drawn once merged is showing: a merged PR also lights up the merged
              badge, and stating the same outcome twice on a 13px row blurs both.
            */}
            {s.pr && !s.merged && (
              <span
                className="shrink-0 rounded-md border border-line px-1 text-2xs leading-body text-ink-faint"
                data-testid={`pr-badge-${s.id}`}
                title={`Pull request #${s.pr.number} — ${s.pr.state}\n${s.pr.url}`}
              >
                PR #{s.pr.number}
                {s.pr.state === 'closed' ? ' ✕' : ''}
              </span>
            )}
            {/*
              Background work still running (#290) — the header's count, on the row. A session whose turn
              ended can still have agents or shells running behind it; restarting or interrupting it would
              end them.
            */}
            <BackgroundMark tasks={s.backgroundTasks} testId={`background-mark-${s.id}`} />
            {/*
              An unread dot used to be here and **was removed** (dogfooding, 2026-09-02).

              It was stating the same fact for a third time on this row: the tool mark's
              border already states the state (an ink-muted ring when a turn ends), and the
              name's brightness already states unread (the text-ink above). Since all
              three lit up together when a turn ended while the person was away, the dot
              added no information, only the question "what is that now" — and that
              question was actually asked. The determination logic (lastReadSeq, markRead)
              is unchanged.
            */}
          </button>
          {/*
            One menu instead of four icons (pencil, handoff, worktree, delete) — a
            dogfooding request, the same grammar as the project row. With four icons it
            turned into an unlabeled game of matching pictures, and two of them (handoff,
            delete) were the kind that must not be pressed by mistake.
          */}
          {/*
            The right padding has to match the project header's px-3 — the two are
            buttons standing in the same vertical column in the sidebar, and leaving them
            at 4px and 12px stood out immediately to the eye (a dogfooding finding).
            Fixing only one side would put them out of alignment again, so the value is
            kept matched.
          */}
          <span
            className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
              sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
            }`}
            data-testid={`session-actions-${s.id}`}
          >
            {/* A plain button like the project's ⋯ — a named menu opens right away, so a tooltip is noise */}
            <button
              type="button"
              aria-label={`Actions for ${s.name}`}
              onClick={(e) => {
                // Reading it inside the updater is too late — React clears currentTarget once the handler returns
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
