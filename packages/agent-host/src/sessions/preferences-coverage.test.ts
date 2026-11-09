import { describe, expect, it } from 'vitest'
import { UiPreferences, UiPreferencesPatch } from '@cc/protocol'
import type { z } from 'zod'
import { CENTRALU_TOOLS } from './tool-definitions.js'
import { NOTIFY_SWITCHES_RETIRED, PREFERENCE_COVERAGE } from './preferences-coverage.js'

const fieldsOf = (tool: string): z.ZodObject<Record<string, z.ZodTypeAny>> => {
  const t = CENTRALU_TOOLS.find((x) => x.name === tool)
  if (!t) throw new Error(`no tool ${tool}`)
  return t.schema
}
const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny => ('unwrap' in s && typeof s.unwrap === 'function' ? unwrap(s.unwrap()) : s)

describe('the Assistant reaches every preference the person can set (#1978)', () => {
  const stored = Object.keys(UiPreferences.shape)

  it('names every stored preference, and nothing that is not one', () => {
    expect(Object.keys(PREFERENCE_COVERAGE).sort()).toEqual([...stored].sort())
  })

  it('each one is a field of the tool it names, or is excluded with a reason', () => {
    for (const [key, reach] of Object.entries(PREFERENCE_COVERAGE)) {
      if ('excluded' in reach) expect(reach.excluded.length, `${key}: say why it is excluded`).toBeGreaterThan(20)
      else expect(Object.keys(fieldsOf(reach.tool).shape), `${key} -> ${reach.tool}.${reach.field}`).toContain(reach.field)
    }
  })

  it('each switch inside notifyPolicy and autoCompact is a field of set_preferences, or retired', () => {
    const shape = (s: z.ZodTypeAny) => (unwrap(s) as z.ZodObject<Record<string, z.ZodTypeAny>>).shape
    const patch = UiPreferencesPatch.shape
    const given = fieldsOf('set_preferences').shape
    const notify = Object.keys(shape(patch.notifyPolicy)).filter((k) => !NOTIFY_SWITCHES_RETIRED.includes(k))
    expect(Object.keys(shape(unwrap(given.notifications!))).sort()).toEqual(notify.sort())
    expect(Object.keys(shape(unwrap(given.autoCompact!))).sort()).toEqual(Object.keys(shape(patch.autoCompact)).sort())
  })
})
