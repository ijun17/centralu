/**
 * The settings a session keeps (`<name>:<sessionId>` in app_settings) go when it is deleted for good (#850 round 4).
 *
 * The purge used to delete two of them by name, and every key added since (a process's tool prefix and launch
 * settings, the fresh-start mark, the last import, a paused report) stayed in the store for good.
 */
import { describe, expect, it } from 'vitest'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'
import { asideKeyOf } from './store/settings.js'

const session = (s: Store, id: string) =>
  s.sessions.upsertSession({
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })

const KEEP_ALL = { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

/**
 * Every per-session key the host writes today, as its builder spells it: `agentDepthKey`, `hubAskDepthKey`
 * (sessions/agent-depth.ts), `pausedReportKey` (child-ownership.ts), `freshStartKey` (session-start.ts),
 * `codeIntelligenceKey` (tool-profiles.ts), the three of launch-records.ts, `externalSyncedKey`
 * (external-conversations.ts), app-access.ts's session list and the names a session has seen its apps under
 * (`APP_NAMES_PREFIX`, session-apps.ts, #1141).
 */
const PER_SESSION = [
  'agent_depth', 'hub_ask_depth', 'report_paused', 'fresh_start', 'code_intelligence',
  'background_tasks', 'tool_prefix', 'launch_settings', 'auto_compact_ceiling', 'external_synced', 'session_apps', 'session_app_names',
  // Where a list setting sets aside a value it could not read (#384, `asideKeyOf`)
  asideKeyOf('session_apps:x').slice(0, -2),
]

describe('purging a session deletes the settings it keeps', () => {
  it('every key of the shape <name>:<sessionId>, and nothing of another session or of the install', async () => {
    const s = new Store()
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    const gone = '0b5a3c1e-6f0d-4c2a-9a51-2a7f1f0c9e11'
    const kept = '7d9e2f40-1c3b-4e8a-b6d2-5f0a9c3e7b22'
    session(s, gone)
    session(s, kept)
    for (const name of PER_SESSION) {
      s.settings.setAppSetting(`${name}:${gone}`, '1')
      s.settings.setAppSetting(`${name}:${kept}`, '1')
    }
    // Not of the purged session: an install setting, an app key, and a key that only contains its id
    const others = ['orchestrator_tool', `app_shared:p1/notes`, `${gone}:not-a-session-key`, gone]
    for (const key of others) s.settings.setAppSetting(key, '1')

    await s.trash.trashSession(gone, KEEP_ALL)
    expect(await s.trash.purgeSession(gone)).toBe(true)

    expect(PER_SESSION.filter((name) => s.settings.appSetting(`${name}:${gone}`) !== null)).toEqual([])
    expect(PER_SESSION.filter((name) => s.settings.appSetting(`${name}:${kept}`) === null)).toEqual([])
    expect(others.filter((key) => s.settings.appSetting(key) === null)).toEqual([])
    s.close()
  })

  // #1142: matched by a trailing :<id>, a session whose id ends in another's lost its keys with it
  it('keeps the keys of a session whose id ends in the purged id', async () => {
    const s = new Store()
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    session(s, 'b')
    session(s, 'a:b')
    s.settings.setAppSetting('tool_prefix:b', '1')
    s.settings.setAppSetting('tool_prefix:a:b', '2')
    await s.trash.trashSession('b', KEEP_ALL)
    expect(await s.trash.purgeSession('b')).toBe(true)
    expect(s.settings.appSetting('tool_prefix:b')).toBeNull()
    expect(s.settings.appSetting('tool_prefix:a:b')).toBe('2')
    s.close()
  })

  it('a session that stays in the session archive keeps them, for a restore', async () => {
    const s = new Store()
    s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
    session(s, 's1')
    s.settings.setAppSetting('tool_prefix:s1', 'abc')
    await s.trash.trashSession('s1', KEEP_ALL)
    expect(s.settings.appSetting('tool_prefix:s1')).toBe('abc')
    s.close()
  })
})
