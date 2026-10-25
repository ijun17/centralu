import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from './claude/index.js'
import { CodexAdapter } from './codex/index.js'

/**
 * The launch fingerprint decides whether a kept or sleeping process is replaced when the settings change. `edits` launches
 * as `normal` (#1525), so switching between the two must not replace it: a sleeping session would otherwise restart on wake.
 */
const settings = (permissionPreset: 'safe' | 'normal' | 'edits' | 'auto') => ({ cwd: '/p', permissionPreset, projectTrusted: true })

describe.each([
  ['Claude', new ClaudeAdapter()],
  ['Codex', new CodexAdapter()],
])('%s launch fingerprint (#1525)', (_name, adapter) => {
  it('reads edits as normal, so switching between them replaces no process', () => {
    expect(adapter.launchSettingsFingerprint(settings('edits'))).toBe(adapter.launchSettingsFingerprint(settings('normal')))
  })

  it('still tells safe and auto apart from normal and from each other', () => {
    const fingerprints = (['safe', 'normal', 'auto'] as const).map((p) => adapter.launchSettingsFingerprint(settings(p)))
    expect(new Set(fingerprints).size).toBe(3)
    expect(adapter.launchSettingsFingerprint(settings('edits'))).not.toBe(adapter.launchSettingsFingerprint(settings('safe')))
    expect(adapter.launchSettingsFingerprint(settings('edits'))).not.toBe(adapter.launchSettingsFingerprint(settings('auto')))
  })
})
