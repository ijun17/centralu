import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAbout } from './usage.js'

/** The real output of `agent about --format json` (agent 2026.10.22-27dcf5f, Windows), the account's email replaced */
const RECORDED = readFileSync(join(import.meta.dirname, 'recordings', 'about.json'), 'utf8')

describe("Cursor's usage: the plan from `agent about --format json` (#1623)", () => {
  it('reads the plan from the recorded output, and says the tool has no limits to report', () => {
    expect(parseAbout(RECORDED)).toEqual({ plan: 'Free', windows: [], daily: [], noLimits: true })
  })

  it('never carries the account or anything else the command prints', () => {
    expect(JSON.stringify(parseAbout(RECORDED))).not.toMatch(/example\.com|@|win32|cliVersion/)
  })

  it('reads through a line printed before or after the object', () => {
    expect(parseAbout(`Update available\n${RECORDED}\n`).plan).toBe('Free')
  })

  it('leaves the plan out when the tool does not say it (not logged in, a tier it does not name)', () => {
    expect(parseAbout('{"cliVersion":"1","subscriptionTier":null}').plan).toBeNull()
    expect(parseAbout('{"cliVersion":"1"}').plan).toBeNull()
    expect(parseAbout('{"subscriptionTier":"  "}').plan).toBeNull()
  })

  it('reads the object when a notice around it holds a brace', () => {
    expect(parseAbout(`Update available: {x}\n${RECORDED}\nSee {docs}`).plan).toBe('Free')
    expect(parseAbout(`{"subscriptionTier":"Pro"}\n{note}`).plan).toBe('Pro')
  })

  it('throws on output that is not JSON, so the reader answers its plain fallback', () => {
    expect(() => parseAbout('not a json line')).toThrow()
    expect(() => parseAbout('')).toThrow()
  })
})
