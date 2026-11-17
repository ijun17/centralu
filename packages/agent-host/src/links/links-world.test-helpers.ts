import { APP_VERSION, PROTOCOL_VERSION, sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import type { Store } from '../dev-services/store.js'
import type { ConnectionLine } from './tunnel.js'
import type { LinkDeps, PendingProjectDelete, PendingProjectDeleteList } from './link-deps.js'

/** What the linked-hosts tests share: the token, the cleanups a test registers, a temp folder, a handshake line and a seeded session */
export const TOKEN = 'tok'

export const cleanups: (() => Promise<void> | void)[] = []
/** `afterEach(runCleanups)`: what a test registered, last first */
export async function runCleanups(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c()
}

/** A temp folder, removed after the test */
export function folder(): string {
  const d = tempRoot('cc-links-')
  cleanups.push(() => removeTree(d))
  return d
}

/** The deletes a hub owes its machines (#2330), kept for the test only: a hub without a store behind them */
export function heldProjectDeletes(): PendingProjectDeleteList {
  let held: readonly PendingProjectDelete[] = []
  return { read: () => [...held], write: (list) => void (held = list) }
}

/** For the tests that delete no project of a machine that is away: nothing is owed, and the person is told nothing */
export const nothingOwed = (): Pick<LinkDeps, 'projectDeletes' | 'tellPerson'> => ({ projectDeletes: heldProjectDeletes(), tellPerson: () => {} })

export const lineFor = (port: number, over: Partial<ConnectionLine> = {}): ConnectionLine => ({
  v: 1,
  port,
  token: TOKEN,
  version: APP_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  dataDir: '/remote',
  hostRunning: true,
  ...over,
})

export function seedSession(
  store: Store,
  projectId: string | null,
  id: string,
  kind: SessionInfo['kind'] = 'worker',
  externalId: string | null = null,
  over: Partial<SessionInfo> = {},
) {
  store.sessions.upsertSession({
    id,
    projectId,
    kind,
    tool: 'claude',
    externalId,
    name: id,
    autoNamed: false,
    state: 'idle',
    lastReadSeq: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    waitingSince: null,
    live: false,
    model: null,
    effort: null,
    verbosity: null,
    serviceTier: null,
    permissionPreset: 'normal',
    importedFrom: null,
    worktree: null,
    parentSessionId: null,
    // A coordinator is a session with a visibility list (store.ts)
    scopeSessionIds: kind === 'coordinator' ? ['worker1'] : null,
    roleAppend: null,
    appId: null,
    ...sessionLiveDefaults(),
    ...over,
  })
}
