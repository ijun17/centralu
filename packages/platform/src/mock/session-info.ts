import type { ProjectInfo, SessionInfo } from '@cc/protocol/client'
import { sessionLiveDefaults } from '@cc/protocol/client'

/** A new idle worker session as the mock makes it; each call site says only what differs. */
export function mockSessionInfo(over: Pick<SessionInfo, 'id' | 'projectId' | 'tool' | 'name' | 'createdAt' | 'externalId'> & Partial<SessionInfo>): SessionInfo {
  return {
    kind: 'worker', autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0, waitingSince: null, live: true,
    model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null,
    worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null,
    ...sessionLiveDefaults(),
    ...over,
  }
}

/** A newly registered project as the mock makes it: untrusted (M4, decision 3), on `main`, no model or command chosen (#107). */
export function mockProjectInfo(over: Pick<ProjectInfo, 'id' | 'path' | 'name' | 'defaultTool'> & Partial<ProjectInfo>): ProjectInfo {
  return {
    defaultModels: {}, commands: [], worktreeSetup: null, agentInstructions: '', worktreeManager: null, trusted: false,
    git: { branch: 'main', changedFiles: 0, isRepo: true },
    ...over,
  }
}
