import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildInbox, countWaiting, isAway, type InboxItem, type WaitingCounts } from '@cc/core'
import { openProjectOf, useStore, type AppState } from './store.js'
import type { ToolDescriptor, ToolName, ToolStatus } from '@cc/protocol/client'
import type { SessionSummary } from '@cc/core'
import { candidates } from './inbox.js'
import { machineNameOf, projectMachineOf } from './names.js'

// Derived state, never stored (docs/state-management.md §3). A selector that builds a new object per call
// re-renders forever: pull a stable reference and useMemo, or wrap it in `useShallow` (what is always on
// screen, docs/state-management.md §3).

/** Empty until the host's first snapshot: the list is data, so a new adapter needs no rebuild */
export function useTools(): ToolStatus[] {
  return useStore((s) => s.tools)
}

/**
 * Falls back to the bare identifier: a stored session can name a tool this build has no adapter for
 * (removed, or from a newer build), and throwing would crash the sidebar.
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

export function useCounts(): WaitingCounts {
  return useStore(useShallow((s) => countWaiting(candidates(s))))
}

export function useSessionsOf(projectId: string): SessionSummary[] {
  return useStore(useShallow((s) => Object.values(s.sessions).filter((x) => x.projectId === projectId)))
}

export function useFocusedSession(): SessionSummary | undefined {
  return useStore((s) => (s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined))
}

/**
 * In the grid no sidebar row is selected: a row lit by `focusedSessionId` alone would stay lit beside the grid.
 * One place, so the session and project rows agree.
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

/** The machine a project lives on (#82), null for this computer; what is off for a remote one asks this (docs/plans/remote-hub.md §6) */
export function useProjectMachine(projectId: string | null | undefined): string | null {
  return useStore((s) => projectMachineOf(s.projects, projectId))
}

/**
 * What a session's paths are relative to (#1209); null (the Assistant) links nowhere. One answer for the conversation's
 * links and the approval rows, or a worktree session's link would open the main checkout's file.
 */
export function sessionFolderOf(state: Pick<AppState, 'sessions' | 'projects'>, sessionId: string): string | null {
  const s = state.sessions[sessionId]
  if (!s) return null
  return s.worktree?.path ?? (s.projectId ? state.projects[s.projectId]?.path : undefined) ?? null
}

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
