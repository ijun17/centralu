import { describe, expect, it } from 'vitest'
import { guiCommandFor } from './guiCommands.js'

describe('which text is a GUI command', () => {
  it('is the name alone, with surrounding whitespace allowed', () => {
    expect(guiCommandFor(' /usage ')?.name).toBe('usage')
    expect(guiCommandFor('/usage summarize last week')).toBeNull()
  })

  // #1143 U17: the box before the orchestrator exists has no session to open a menu for
  it('leaves out a command that acts on a session when there is none', () => {
    expect(guiCommandFor('/model')?.name).toBe('model')
    expect(guiCommandFor('/model', false)).toBeNull()
  })

  it('keeps the commands that need no session when there is none', () => {
    expect(guiCommandFor('/usage', false)?.name).toBe('usage')
    expect(guiCommandFor('/settings', false)?.name).toBe('settings')
  })
})
