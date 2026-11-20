import { describe, expect, it } from 'vitest'
import { toSnap } from './UsageDonuts.jsx'

describe('toSnap — whether a tool reports limits (#1616)', () => {
  it('is never only for the host’s own mark that the tool has no way to report them', () => {
    expect(toSnap({ supported: false, notReported: true, usage: null }).limits).toBe('never')
  })

  it('is unknown for a failed read, and for an older host that sends no mark', () => {
    expect(toSnap({ supported: false, reason: 'not logged in', usage: null }).limits).toBe('unknown')
    expect(toSnap({ supported: false, notReported: false, usage: null }).limits).toBe('unknown')
  })

  it('is read when the host could read them', () => {
    expect(toSnap({ supported: true, usage: null }).limits).toBe('read')
  })
})
