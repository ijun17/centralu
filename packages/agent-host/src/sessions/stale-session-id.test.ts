import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { staleSessionHint } from './stale-session-id.js'

const live = (id: string, name: string, projectId: string) => ({ id, name, projectId, kind: 'session' }) as unknown as SessionInfo
const hostWith = (trashedProject: string, sessions: SessionInfo[]) => ({
  meta: new Map(sessions.map((s) => [s.id, s])),
  store: {
    trash: { trashedSession: (id: string) => (id === 'old' ? { session: { name: 'Fix login' }, record: { projectId: trashedProject } } : null) },
    handoffs: { handoffHeirs: () => [] },
  } as unknown as Store,
})

describe('staleSessionHint', () => {
  const sessions = [live('new', 'Fix login', 'p1'), live('other', 'Fix login', 'p2')]
  it('names the deleted session and the live one of the same name and project, not another project\'s', () => {
    const hint = staleSessionHint(hostWith('p1', sessions), 'old', () => true)
    expect(hint).toContain('"Fix login" (id new)')
    expect(hint).not.toContain('other')
  })
  it('says nothing of an archived session in a project the caller does not see', () => {
    expect(staleSessionHint(hostWith('p3', sessions), 'old', () => true)).toBe('')
    expect(staleSessionHint(hostWith('p3', sessions), 'old', () => true, true)).toContain('deleted')
  })
  it('says nothing for a live session out of view, or an id nobody had', () => {
    expect(staleSessionHint(hostWith('p1', sessions), 'new', () => false)).toBe('')
    expect(staleSessionHint(hostWith('p1', sessions), 'nobody', () => true)).toBe('')
  })
})
