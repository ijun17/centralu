import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { hostBuild, hostBusy, startActivityReport, type ActivitySnapshot } from './keeper-link.js'

const idle: ActivitySnapshot = { sessions: [], terminals: 0, commandRuns: 0 }

describe('hostBuild', () => {
  it('names the compiled-in commit and the protocol even with no keeper', () => {
    expect(hostBuild('abc1234', undefined)).toEqual({ commit: 'abc1234', protocolVersion: PROTOCOL_VERSION })
  })

  it('adds where the keeper copied the build from', () => {
    const source = JSON.stringify({
      commit: 'abc1234',
      version: '0.1.0-beta.6',
      bundlePath: '/Applications/Centralu.app',
      copyDir: '/Users/x/.centralu/hosts/abc1234',
    })
    expect(hostBuild('abc1234', source)).toEqual({
      commit: 'abc1234',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.1.0-beta.6',
      bundlePath: '/Applications/Centralu.app',
      copyDir: '/Users/x/.centralu/hosts/abc1234',
    })
  })

  /** The identity is the code's own; a record can describe a build, not rename it */
  it('keeps its own commit when the record names another', () => {
    expect(hostBuild('abc1234', JSON.stringify({ commit: 'zzz' })).commit).toBe('abc1234')
  })

  it('starts with what it has when the record is unreadable', () => {
    expect(hostBuild('abc1234', '{not json')).toEqual({ commit: 'abc1234', protocolVersion: PROTOCOL_VERSION })
    expect(hostBuild('abc1234', JSON.stringify({ bundlePath: 42 }))).toEqual({ commit: 'abc1234', protocolVersion: PROTOCOL_VERSION })
  })
})

describe('hostBusy', () => {
  it('is idle with nothing running', () => {
    expect(hostBusy(idle)).toBe(false)
    expect(hostBusy({ ...idle, sessions: [{ state: 'idle', live: true }, { state: 'error', live: true }] })).toBe(false)
  })

  it('is busy while a live session works or waits on a person', () => {
    for (const state of ['working', 'waiting_approval', 'waiting_input'] as const) {
      expect(hostBusy({ ...idle, sessions: [{ state, live: true }] }), state).toBe(true)
    }
  })

  it('does not count a session whose process is gone', () => {
    expect(hostBusy({ ...idle, sessions: [{ state: 'working', live: false }] })).toBe(false)
  })

  it('is busy with an open terminal or a running command', () => {
    expect(hostBusy({ ...idle, terminals: 1 })).toBe(true)
    expect(hostBusy({ ...idle, commandRuns: 1 })).toBe(true)
  })
})

describe('startActivityReport', () => {
  it('reports once at start and then only on a change', () => {
    vi.useFakeTimers()
    try {
      let snap = idle
      const lines: string[] = []
      const stop = startActivityReport(() => snap, (l) => lines.push(l), 1000)
      expect(lines).toEqual(['{"activity":{"busy":false}}'])
      vi.advanceTimersByTime(3000)
      expect(lines).toHaveLength(1)
      snap = { ...idle, terminals: 1 }
      vi.advanceTimersByTime(1000)
      expect(lines.at(-1)).toBe('{"activity":{"busy":true}}')
      stop()
      snap = idle
      vi.advanceTimersByTime(5000)
      expect(lines).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
