import { describe, expect, it, vi } from 'vitest'
import { ABOUT_RECORDED as RECORDED } from './recordings/about.test-helpers.js'
import { cursorUsageReader, parseAbout } from './usage.js'

describe("Cursor's usage: the plan from `agent about --format json` (#1623)", () => {
  it('reads the plan from the recorded output', () => {
    expect(parseAbout(RECORDED)).toEqual({ plan: 'Free' })
  })

  it('never carries the account or anything else the command prints', () => {
    expect(JSON.stringify(parseAbout(RECORDED))).not.toMatch(/example\.com|@|win32|cliVersion/)
  })

  it('reads through a line printed before or after the object', () => {
    expect(parseAbout(`Update available\n${RECORDED}\n`).plan).toBe('Free')
  })

  it('leaves the plan out when the tool does not name one (no field, a blank one)', () => {
    expect(parseAbout('{"cliVersion":"1"}')).toEqual({ plan: null })
    expect(parseAbout('{"subscriptionTier":"  "}')).toEqual({ plan: null })
  })

  it('says nobody is logged in when the tier is null (exit 0, measured in review RV1625)', () => {
    expect(parseAbout('{"cliVersion":"1","subscriptionTier":null,"userEmail":null}')).toEqual({ plan: null, loggedOut: true })
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

describe("Cursor's reader: logged out is never served stale (#1623)", () => {
  const OUT = JSON.stringify({ subscriptionTier: null })
  const FREE = JSON.stringify({ subscriptionTier: 'Free' })

  it('reads a logged-out answer again after 10 s and not before (a login is seen at once)', async () => {
    let clock = 0
    const run = vi.fn(async () => OUT)
    const ask = cursorUsageReader(run, () => clock)
    expect((await ask({ settle: true })).loggedOut).toBe(true)
    clock = 9_000
    await ask()
    expect(run).toHaveBeenCalledTimes(1)
    clock = 11_000
    await ask()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  })

  it('keeps a plan fresh for five minutes', async () => {
    let clock = 0
    const run = vi.fn(async () => FREE)
    const ask = cursorUsageReader(run, () => clock)
    await ask({ settle: true })
    clock = 200_000
    expect(await ask()).toEqual({ plan: 'Free' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not return the old logged-out answer while it is read again, nor when that read fails', async () => {
    let clock = 0
    const run = vi.fn<() => Promise<string>>().mockResolvedValueOnce(OUT).mockRejectedValue(new Error('timed out'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ask = cursorUsageReader(run, () => clock)
    await ask({ settle: true })
    clock = 20_000
    const after = await ask({ settle: true })
    expect(after.loggedOut).toBeUndefined()
    expect(after.provisional).toBeUndefined()
    clock = 30_000
    expect((await ask()).loggedOut).toBeUndefined()
  })

  it('answers a logged-out one that is stale as provisional with no plan, not as logged out, while the read goes on', async () => {
    let clock = 0
    let release!: () => void
    const run = vi.fn<() => Promise<string>>().mockResolvedValueOnce(OUT).mockImplementationOnce(() => new Promise((r) => (release = () => r(FREE))))
    const ask = cursorUsageReader(run, () => clock)
    await ask({ settle: true })
    clock = 20_000
    const during = await ask()
    expect(during.loggedOut).toBeUndefined()
    expect(during.provisional).toBe(true)
    release()
  })
})
