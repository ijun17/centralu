import { describe, expect, it } from 'vitest'
import { parseCliVersion, runsOlderCli } from './agent-version.js'

describe('reading an agent CLI version (#297)', () => {
  it('finds the version in each shape the CLIs print (measured 2026-10-05)', () => {
    expect(parseCliVersion('2.1.289 (Claude Code)\n')).toBe('2.1.289')
    expect(parseCliVersion('codex-cli 0.160.0')).toBe('0.160.0')
    expect(parseCliVersion('0.161.0-alpha.2 (Mac OS 27.0.1; arm64)')).toBe('0.161.0-alpha.2')
  })

  it('takes the server version from a Codex user agent, not the OS version or ours that follow it', () => {
    const ua = 'centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)'
    expect(parseCliVersion(ua.slice(ua.indexOf('/') + 1))).toBe('0.160.0')
  })

  it('says nothing when there is no version', () => {
    expect(parseCliVersion('command not found')).toBeNull()
    expect(parseCliVersion('')).toBeNull()
  })
})

describe('whether a session runs an older CLI than the installed one (#297)', () => {
  it('is older only when the installed version outranks the running one', () => {
    expect(runsOlderCli('2.1.282', '2.1.290')).toBe(true)
    // numeric, not string: 2.1.290 is newer than 2.1.29
    expect(runsOlderCli('2.1.29', '2.1.290')).toBe(true)
    expect(runsOlderCli('2.1.290', '2.1.290')).toBe(false)
    // a session started after a downgrade runs the newer one: that is not "older"
    expect(runsOlderCli('2.1.290', '2.1.282')).toBe(false)
    expect(runsOlderCli('0.160.0-alpha.1', '0.160.0')).toBe(true)
  })

  it('is never older when either side is unknown — nothing restarts on a guess', () => {
    expect(runsOlderCli(null, '2.1.290')).toBe(false)
    expect(runsOlderCli('2.1.282', null)).toBe(false)
    expect(runsOlderCli(undefined, undefined)).toBe(false)
  })
})
