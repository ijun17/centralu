import type {
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  SubagentStepsHeld,
  TrashedRun,
  TrashedSession,
  TrashedSubagentSteps,
} from '@cc/protocol/client'

/** Conversation search and approval-rule management (E-1, E-4) */
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
      /** The rule's owner — projectId for project scope, sessionId for session scope (#183) */
      projectId?: string | null
      sessionId?: string | null
    }[]
  >
  remove(id: number): Promise<void>
}

/**
 * The session archive (#204; called the trash until #1404, hence `TrashPort` and the `trash.*` protocol methods). Archiving a session moves it here; these are the ways out, and they belong to the person
 * (Settings → Archive). Nothing here is emptied on its own, so `list` carries the total size.
 */
export interface TrashPort {
  /**
   * `runs`: the records of deleted app-agent sessions (#378), each with its machine; `bytes` counts them too.
   * `unreached`: linked machines whose trash could not be read, so the list is not the whole trash (#841).
   * `subagentSteps`: sessions' subagent steps in the session archive without their session (#418), their bytes in `bytes`; absent
   * from a host before it
   */
  list(): Promise<{
    sessions: TrashedSession[]
    runs: TrashedRun[]
    bytes: number
    unreached?: { machineId: string; name: string }[]
    subagentSteps?: TrashedSubagentSteps[]
  }>
  /** A archived conversation, read-only — pages like `AgentPort.loadMessages` */
  read(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /** Back as it was. `project` is set when its project had been deleted and restoring registered the folder again */
  restore(sessionId: string): Promise<{ session: SessionInfo; project: ProjectInfo | null }>
  /** Deletes one for good, with what the person chose to remove with it */
  purge(sessionId: string): Promise<void>
  /** Deletes every session in it for good; one that fails stays in the session archive and is reported. Run records are `purgeRuns`' */
  empty(): Promise<{ purged: number; failed: { sessionId: string; name: string; error: string }[] }>
  /**
   * An app-agent run's record (#378): its request, answer and structured output, and a page of its conversation.
   * `machine` is the record's (`TrashedRun.machine`): a linked machine's is read there
   */
  readRun(runId: string, limit?: number, beforeSeq?: number, machine?: string | null): Promise<{ request: string; answer: string; output?: unknown; messages: StoredMessage[] }>
  /** Deletes app-agent run records for good (#378), all of one machine (`machine`, as `readRun`) */
  purgeRuns(runIds: string[], machine?: string | null): Promise<{ purged: number }>
  /** What each live session's subagent steps take (#418), largest first; Settings → Archive lists them */
  subagentUsage(): Promise<{ sessions: SubagentStepsHeld[]; unreached?: { machineId: string; name: string }[] }>
  /** Archives a live session's subagent steps (#418); the conversation and its launch cards stay */
  trashSubagentSteps(sessionId: string): Promise<{ steps: number; bytes: number }>
  /** Puts a session's archived subagent steps back under their cards (#418) */
  restoreSubagentSteps(sessionId: string): Promise<void>
  /**
   * Deletes a session's archived subagent steps for good (#418), those moved there at or before `upTo`: the entry's
   * `deletedAt` as listed, so steps moved after the list was read stay. `empty` leaves them; the session stays
   */
  purgeSubagentSteps(sessionId: string, upTo: number): Promise<void>
}
