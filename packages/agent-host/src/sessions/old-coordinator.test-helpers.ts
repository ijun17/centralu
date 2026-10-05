import { randomUUID } from 'node:crypto'
import { SessionInfo, type ToolName } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { orchestratorHome } from './orchestrator-home.js'

/**
 * Puts a coordinator in the store the way a build from before #372 left one (the control app's task foremen):
 * no project, its members in `scopeSessionIds`, its role text, the orchestrator's home as its folder, and no process.
 * Nothing in this build creates a coordinator any more, so a test of how one reads, wakes and reports starts from the
 * row, and a `SessionManager` opened over the store afterwards finds it like any other session.
 */
export function plantOldCoordinator(
  store: Store,
  o: {
    name: string
    memberSessionIds: string[]
    roleAppend: string
    tool: ToolName
    appId?: string | null
    /** The tool's conversation it had; absent, it wakes into a new one */
    externalId?: string | null
  },
): string {
  const id = randomUUID()
  store.upsertSession(
    SessionInfo.parse({
      id,
      projectId: null,
      kind: 'coordinator',
      tool: o.tool,
      externalId: o.externalId ?? null,
      name: o.name,
      autoNamed: false,
      state: 'idle',
      createdAt: Date.now(),
      live: false,
      scopeSessionIds: o.memberSessionIds,
      roleAppend: o.roleAppend,
      appId: o.appId ?? null,
    }),
  )
  store.setSessionCwd(id, orchestratorHome())
  return id
}
