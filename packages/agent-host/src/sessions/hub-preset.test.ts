import { describe, expect, it } from 'vitest'
import { presetFromHub } from './hub-preset.js'

/*
 * An `auto` caller's preset carried from a hub (#1273) runs `auto` here only while this computer's switch is on and the
 * project here is trusted: an untrusted project stays `normal` at most (owner decision 2026-11-05).
 */
describe('a start carried from a hub', () => {
  const carried = { permissionPreset: 'normal' as const, fromHub: { callerPreset: 'auto' as const } }

  it("takes an auto caller's preset in a trusted project while the switch is on", () => {
    expect(presetFromHub(carried, { hubAuto: true }, true)).toBe('auto')
  })

  it('keeps normal in an untrusted project, the switch on or off', () => {
    expect(presetFromHub(carried, { hubAuto: true }, false)).toBe('normal')
    expect(presetFromHub(carried, { hubAuto: false }, false)).toBe('normal')
  })
})
