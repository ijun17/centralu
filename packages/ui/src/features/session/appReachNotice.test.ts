import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol/client'
import { droppedAppTitle } from './appReachNotice.js'

const app = (name: string, machine: string | null): ExternalAppInfo => ({ appId: 'notes', projectId: null, name, machine }) as ExternalAppInfo

describe('the app a link was dragged from (#2173)', () => {
  const apps = [app('Notes here', null), app('Notes there', 'm1')]

  it('is this computer’s user-folder app, or the linked machine’s when the drag came out of that one', () => {
    expect(droppedAppTitle(apps, { appId: 'notes', projectId: null })).toBe('Notes here')
    expect(droppedAppTitle(apps, { appId: 'notes', projectId: null, machine: null })).toBe('Notes here')
    expect(droppedAppTitle(apps, { appId: 'notes', projectId: null, machine: 'm1' })).toBe('Notes there')
  })

  it('falls back to the id when the list has no such app', () => {
    expect(droppedAppTitle([app('Notes here', null)], { appId: 'notes', projectId: null, machine: 'm1' })).toBe('notes')
  })
})
