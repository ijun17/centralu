import type {
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  SubagentStepsHeld,
  TrashedRun,
  TrashedSession,
  TrashedSubagentSteps,
} from '@cc/protocol/client'

export interface SearchPort {
  messages(query: string, limit?: number): Promise<{ sessionId: string; seq: number; snippet: string }[]>
}

export interface ApprovalRulesPort {
  list(): Promise<
    {
      id: number
      scope: string
      matcher: string
      decision: string
      createdAt: number
      /** The owner: projectId for project scope, sessionId for session scope (#183) */
      projectId?: string | null
      sessionId?: string | null
    }[]
  >
  remove(id: number): Promise<void>
}

/**
 * The session archive (#204, docs/protocol.md §3). Its ways out are the person's (Settings → Archive); nothing empties
 * on its own, so `list` carries the total size.
 */
export interface TrashPort {
  list(): Promise<{
    sessions: TrashedSession[]
    runs: TrashedRun[]
    bytes: number
    unreached?: { machineId: string; name: string }[]
    subagentSteps?: TrashedSubagentSteps[]
  }>
  read(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /** `project` is set when its deleted project's folder was registered again */
  restore(sessionId: string): Promise<{ session: SessionInfo; project: ProjectInfo | null }>
  /** Deletes for good, with what the person chose to remove with it */
  purge(sessionId: string): Promise<void>
  empty(): Promise<{ purged: number; failed: { sessionId: string; name: string; error: string }[] }>
  readRun(runId: string, limit?: number, beforeSeq?: number, machine?: string | null): Promise<{ request: string; answer: string; output?: unknown; messages: StoredMessage[] }>
  purgeRuns(runIds: string[], machine?: string | null): Promise<{ purged: number }>
  subagentUsage(): Promise<{ sessions: SubagentStepsHeld[]; unreached?: { machineId: string; name: string }[] }>
  trashSubagentSteps(sessionId: string): Promise<{ steps: number; bytes: number }>
  restoreSubagentSteps(sessionId: string): Promise<void>
  purgeSubagentSteps(sessionId: string, upTo: number): Promise<void>
}
