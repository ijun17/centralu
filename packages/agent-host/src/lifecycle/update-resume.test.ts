import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUpdateResume, takeUpdateResumeFrom, UPDATE_RESUME_MAX_AGE_MS, type UpdateResumeFile } from './update-resume.js'

/**
 * The file a linked hub's update leaves for the next host (#1618): the sessions whose turns the stop ended, which that host
 * continues once. Read once, then gone; too old, from another format or unreadable, it continues nothing. The folder is
 * played by a map here; stopped-mark.ts reaches the real one.
 */
const NOW = 1_800_000_000_000
afterEach(() => vi.restoreAllMocks())

/** A data folder holding the file's text, or none */
function folder(text?: string): UpdateResumeFile & { has(): boolean } {
  let held = text
  return {
    read: () => held ?? null,
    remove: () => {
      held = undefined
    },
    has: () => held !== undefined,
  }
}

describe('takeUpdateResumeFrom', () => {
  it('reads the ids once and removes the file, so a host that starts again continues nothing a second time', () => {
    const f = folder(JSON.stringify({ v: 1, at: NOW - 5_000, ids: ['s1', 's2'] }))
    expect([...takeUpdateResumeFrom(f, NOW)]).toEqual(['s1', 's2'])
    expect(f.has()).toBe(false)
    expect([...takeUpdateResumeFrom(f, NOW)]).toEqual([])
  })

  it('finds nothing where no update left a file', () => {
    expect([...takeUpdateResumeFrom(folder(), NOW)]).toEqual([])
  })

  it('removes a file it cannot use too, so it is not read by a later start', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = folder(JSON.stringify({ v: 1, at: NOW - UPDATE_RESUME_MAX_AGE_MS - 1, ids: ['s1'] }))
    expect([...takeUpdateResumeFrom(f, NOW)]).toEqual([])
    expect(f.has()).toBe(false)
  })

  it('continues nothing when the file cannot be removed: left there, the next start would continue the same turns again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stuck: UpdateResumeFile = {
      read: () => JSON.stringify({ v: 1, at: NOW, ids: ['s1'] }),
      remove: () => {
        throw new Error('EPERM')
      },
    }
    expect([...takeUpdateResumeFrom(stuck, NOW)]).toEqual([])
  })
})

describe('parseUpdateResume', () => {
  it('continues nothing from a file older than the bound: an update whose new host never started names turns long over', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect([...parseUpdateResume(JSON.stringify({ v: 1, at: NOW - UPDATE_RESUME_MAX_AGE_MS - 1, ids: ['s1'] }), NOW)]).toEqual([])
    expect([...parseUpdateResume(JSON.stringify({ v: 1, at: NOW - UPDATE_RESUME_MAX_AGE_MS + 1_000, ids: ['s1'] }), NOW)]).toEqual(['s1'])
  })

  it('reads nothing from another format, text that is not JSON, or ids that are not strings', () => {
    expect([...parseUpdateResume(JSON.stringify({ v: 2, at: NOW, ids: ['s1'] }), NOW)]).toEqual([])
    expect([...parseUpdateResume('{"v":1,', NOW)]).toEqual([])
    expect([...parseUpdateResume(JSON.stringify({ v: 1, ids: ['s1'] }), NOW)]).toEqual([])
    expect([...parseUpdateResume(JSON.stringify({ v: 1, at: NOW, ids: ['s1', 7, null, '', 's2'] }), NOW)]).toEqual(['s1', 's2'])
  })
})
