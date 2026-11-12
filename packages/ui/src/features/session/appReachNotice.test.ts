import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol/client'
import { appDropVerdict, droppedAppTitle, otherMachineNotice } from './appReachNotice.js'

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

describe('a user-folder app on another computer than the session (#82)', () => {
  const apps = [app('Notes here', null), app('Notes there', 'm1')]
  const machines = { m1: { name: 'Box' } }
  const from = (machine?: string) => ({ appId: 'notes', projectId: null, ...(machine ? { machine } : {}) })

  it('is told by the window, with the machine’s name, when the app and the session are not on one computer', () => {
    expect(otherMachineNotice(from('m1'), undefined, apps, machines)).toBe('Notes there runs on Box, and this session is on another computer.')
    expect(otherMachineNotice(from(), 'm1', apps, machines)).toBe('Notes here runs on this computer, and this session is on another computer.')
    expect(otherMachineNotice(from('m1'), 'm2', apps, machines)).toBe('Notes there runs on Box, and this session is on another computer.')
  })

  it('says nothing when both are on one computer, or for a project’s app, whose id names its machine', () => {
    expect(otherMachineNotice(from('m1'), 'm1', apps, machines)).toBeNull()
    expect(otherMachineNotice(from(), undefined, apps, machines)).toBeNull()
    expect(otherMachineNotice(from(), null, apps, machines)).toBeNull()
    expect(otherMachineNotice({ appId: 'notes', projectId: 'm1.p1' }, undefined, apps, machines)).toBeNull()
  })
})

describe('what the composer does with a link dragged out of an app (#2223)', () => {
  const apps = [app('Notes here', null), app('Notes there', 'm1')]
  const machines = { m1: { name: 'Box' } }

  it('tells it itself when the user-folder app and the session are on two computers, and asks the host when they are on one', () => {
    const tell = { kind: 'tell', reason: 'other-machine' }
    expect(appDropVerdict({ appId: 'notes', projectId: null, machine: 'm1' }, undefined, apps, machines)).toMatchObject({ ...tell, text: 'Notes there runs on Box, and this session is on another computer.' })
    expect(appDropVerdict({ appId: 'notes', projectId: null }, 'm1', apps, machines)).toMatchObject(tell)
    expect(appDropVerdict({ appId: 'notes', projectId: null, machine: 'm1' }, 'm1', apps, machines)).toEqual({ kind: 'ask' })
    expect(appDropVerdict({ appId: 'notes', projectId: null }, null, apps, machines)).toEqual({ kind: 'ask' })
    // A project's app is the host's to judge: its project id names its machine
    expect(appDropVerdict({ appId: 'board', projectId: 'p1' }, 'm1', apps, machines)).toEqual({ kind: 'ask' })
  })
})
