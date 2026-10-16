import type {
  ProjectInfo,
  SessionInfo,
  StoredMessage,
  TrashedSession,
} from '@cc/protocol'

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
 * The trash (#204). Deleting a session moves it here; these are the ways out, and they belong to the person
 * (Settings → Trash). Nothing here is emptied on its own, so `list` carries the total size.
 */
export interface TrashPort {
  list(): Promise<{ sessions: TrashedSession[]; bytes: number }>
  /** A trashed conversation, read-only — pages like `AgentPort.loadMessages` */
  read(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
  /** Back as it was. `project` is set when its project had been deleted and restoring registered the folder again */
  restore(sessionId: string): Promise<{ session: SessionInfo; project: ProjectInfo | null }>
  /** Deletes one for good, with what the person chose to remove with it */
  purge(sessionId: string): Promise<void>
  /** Deletes all of them for good; one that fails stays in the trash and is reported */
  empty(): Promise<{ purged: number; failed: { sessionId: string; name: string; error: string }[] }>
}
