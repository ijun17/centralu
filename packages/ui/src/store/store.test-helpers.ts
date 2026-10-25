/**
 * What the store tests share: the reset each test starts from, session and app records, and
 * readers that turn the conversation back into text. (A test-only file. Product code never imports it.)
 */
import { expect, vi } from 'vitest'
import type { ExternalAppInfo, NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY } from '@cc/core'
import type { Platform } from '@cc/platform/ports'
import { useStore, type ChatItem } from './store.js'

export function sessionInfo(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: true,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
    appId: null, ...sessionLiveDefaults(), ...over,
  }
}

export const delta = (sessionId: string, text: string) =>
  ({ sessionId, type: 'message_delta', role: 'assistant', text }) as NormalizedEvent

/** Turns one conversation row into human-readable text — a tool's title, an image's kind */
export const line = (i: ChatItem): string =>
  i.kind === 'tool' ? i.title : i.kind === 'image' ? `image:${i.mime}` : i.kind === 'approval' ? i.summary : i.text

/**
 * Reads back as far as a person could — once history stands, keeps pressing "earlier conversation"
 * until there is no more (#79). A wrong cursor shows up here: a gap in the middle (the cursor is too
 * low) or the same row appended twice (too high).
 */
export async function readAll(id: string): Promise<string[]> {
  await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  for (let i = 0; i < 50 && useStore.getState().history[id]!.more; i++) await useStore.getState().loadOlder(id)
  return useStore.getState().chat[id]!.map(line)
}

/** Holds the next `sessions.list` answer (read at the moment it was asked) until `release` */
export function holdList(mock: Pick<Platform, 'agents'>): { asked: Promise<void>; release: () => void } {
  const real = mock.agents.listSessions
  let release!: () => void
  let askedNow!: () => void
  const asked = new Promise<void>((r) => (askedNow = r))
  mock.agents.listSessions = async () => {
    mock.agents.listSessions = real
    const snapshot = await real()
    const held = new Promise<void>((r) => (release = r))
    askedNow()
    await held
    return snapshot
  }
  return { asked, release: () => release() }
}

/** A single discovered external app (one row of the host's `apps.list`) */
export function appInfo(appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo {
  return {
    appId, projectId: 'p1', dir: `/tmp/p1/.centralu/apps/${appId}`, name: `App ${appId}`, version: '0.1.0',
    description: null, home: 'home', trusted: true, status: 'stopped', error: null, warnings: [], ...over,
  }
}

/** Every test starts from an empty store with no platform attached */
export function resetStore() {
  useStore.setState({
    platform: null,
    connection: 'connecting',
    projects: {},
    sessions: {},
    chat: {},
    drafts: {},
    keptDrafts: [],
    stickToBottom: {},
    searchTargets: {},
    workingSince: {},
    expandedDirs: {},
    showIgnored: true,
    foldedProjects: [],
    projectPanels: {},
    focusedSessionId: null,
    focusedProjectId: null,
    view: 'focus',
    history: {},
    subagentSteps: {},
    resuming: {},
    wakeError: {},
    wakeLocked: {},
    notices: [],
    mail: null,
    mailThread: null,
    toast: null,
    approvalsInFlight: {},
    commandRuns: {},
    notifyPolicy: DEFAULT_NOTIFY_POLICY,
    externalAppChanges: {},
    externalAppRunChanges: {},
    externalAppChangedBy: {},
    externalApps: [],
    trustAsk: null,
    toastAction: null,
    pinnedViews: [],
    focusedApp: null,
  })
}
