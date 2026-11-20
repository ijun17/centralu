import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildInbox, countWaiting, isAway, type InboxItem, type WaitingCounts } from '@cc/core'
import { openProjectOf, useStore, type AppState } from './store.js'
import type { ToolDescriptor, ToolName, ToolStatus } from '@cc/protocol/client'
import type { SessionSummary } from '@cc/core'
import { candidates } from './inbox.js'
import { machineNameOf, projectMachineOf } from './names.js'

/**
 * All derived state is computed here (docs/state-management.md §3) — never stored.
 * Caution: a zustand selector that builds a new object on every call causes an infinite
 * re-render loop. So either only a stable reference (the sessions map) is pulled out of the store
 * and the computation is wrapped in useMemo, or the selector is wrapped in `useShallow`, which
 * keeps the last result while its entries are the same. The second is for what is always on
 * screen: the sessions map changes with every event of every session, and a component that reads
 * it whole draws again for each of them.
 */

/**
 * The agent tools this machine has, as the host reported them when the app connected.
 *
 * Empty until that first snapshot lands. The list is data, not a constant compiled into
 * `@cc/protocol`, so a new adapter can appear without either side being rebuilt. The cost is
 * this one instant of emptiness, which reads as a row that has not arrived rather than a row
 * that is wrong.
 */
export function useTools(): ToolStatus[] {
  return useStore((s) => s.tools)
}

/**
 * How to present one tool — its label and its one-glyph mark.
 *
 * **Falls back to the bare identifier instead of throwing.** A stored session can name a
 * tool this build has no adapter for: one that was removed, or one from a newer build that
 * wrote the row. Throwing on such a row would crash the middle of the sidebar. A chip that
 * reads `codex` where it should read `Codex` is a smaller failure.
 */
export function useToolMeta(tool: ToolName): ToolDescriptor {
  const tools = useStore((s) => s.tools)
  return useMemo(
    () =>
      tools.find((t) => t.name === tool) ?? {
        name: tool,
        label: tool,
        mark: tool.slice(0, 1).toUpperCase(),
        install: '',
        login: '',
      },
    [tools, tool],
  )
}

export function useInbox(now: number): InboxItem[] {
  const sessions = useStore((s) => s.sessions)
  const mcpProposals = useStore((s) => s.mcpProposals)
  const skillProposals = useStore((s) => s.skillProposals)
  const appArrivals = useStore((s) => s.appArrivals)
  return useMemo(
    () => buildInbox(candidates({ sessions, mcpProposals, skillProposals, appArrivals }), now),
    [sessions, mcpProposals, skillProposals, appArrivals, now],
  )
}

/** The waiting counts the top bar shows: it draws again when a count moves, not on every event of every session */
export function useCounts(): WaitingCounts {
  return useStore(useShallow((s) => countWaiting(candidates(s))))
}

/**
 * A project's sessions, the same array while none of them changed: an event of another project's session does not
 * draw this project's sidebar block again.
 */
export function useSessionsOf(projectId: string): SessionSummary[] {
  return useStore(useShallow((s) => Object.values(s.sessions).filter((x) => x.projectId === projectId)))
}

export function useFocusedSession(): SessionSummary | undefined {
  return useStore((s) => (s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined))
}

/**
 * What is currently selected in the sidebar.
 *
 * While looking at the grid, neither a session nor a project is selected — the grid is what is
 * selected. A session row that looked only at `focusedSessionId` would stay lit after entering
 * the grid, as if it were selected. With two bright things on screen at once, the screen
 * contradicts itself about which one is being looked at.
 *
 * Why this is computed in one place: if the session row and the project row each made their own
 * judgment, one of them would eventually get fixed while the other did not.
 */
export function useSelectedSessionId(): string | null {
  return useStore((s) => (s.view === 'focus' ? s.focusedSessionId : null))
}

export function useIsProjectSelected(projectId: string): boolean {
  return useStore((s) => s.view === 'focus' && s.focusedProjectId === projectId && !s.focusedSessionId)
}

/** Is this project's screen, or one of its sessions, what the focus lane shows (the sidebar tints its group)? */
export function useIsProjectOpen(projectId: string): boolean {
  return useStore((s) => openProjectOf(s) === projectId)
}

/**
 * The linked machine a project lives on (#82), or null for this computer. What stays off for a
 * project on another machine in phase 1 asks this: reveal in the file manager, open in the IDE,
 * moving files to this computer's session archive, app views (docs/plans/remote-hub.md §6).
 */
export function useProjectMachine(projectId: string | null | undefined): string | null {
  return useStore((s) => projectMachineOf(s.projects, projectId))
}

/**
 * The folder a session works in, which every path its conversation names is relative to (#1209): its worktree when it
 * has one, its project's folder otherwise, and null for a session with no project (the Assistant), whose words then
 * link nowhere (`parseFileRef`). One answer for the conversation's links and the approval rows: if the conversation took
 * the project's folder while the rows took the worktree, a worktree session's link would open the main checkout's file.
 */
export function sessionFolderOf(state: Pick<AppState, 'sessions' | 'projects'>, sessionId: string): string | null {
  const s = state.sessions[sessionId]
  if (!s) return null
  return s.worktree?.path ?? (s.projectId ? state.projects[s.projectId]?.path : undefined) ?? null
}

/** `sessionFolderOf` for a component: a string, so the selector is stable */
export function useSessionFolder(sessionId: string): string | null {
  return useStore((s) => sessionFolderOf(s, sessionId))
}

/** A machine's name as the person gave it, or its id until the machine list arrives; null for this computer */
export function useMachineName(machine: string): string
export function useMachineName(machine: string | null | undefined): string | null
export function useMachineName(machine: string | null | undefined): string | null {
  return useStore((s) => (machine ? machineNameOf(s.machines, machine) : null))
}

/** Whether a session's machine is away (#82): shown dimmed, never woken (`isAway` in core) */
export function useSessionAway(sessionId: string): boolean {
  return useStore((s) => isAway(s.sessions[sessionId], s.machines))
}
