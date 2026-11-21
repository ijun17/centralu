/**
 * A descriptor is an object each adapter writes for itself, so no compiler guarantees one entry per tool: these rules
 * (one descriptor per tool, no two sharing a mark, real install and login commands) are asserted across the whole
 * registry, the only place that can see every tool at once.
 *
 * The mark rule is the one that matters in use. It is drawn in a 14px square chip with no
 * label beside it, so two tools sharing a glyph are two tools a person cannot tell apart.
 */
import { describe, expect, it } from 'vitest'
import { createAdapters } from './registry.js'

const descriptors = [...createAdapters().values()].map((a) => a.descriptor)

describe('tool descriptors', () => {
  it('ships at least one adapter', () => {
    expect(descriptors.length).toBeGreaterThan(0)
  })

  it('names each tool once', () => {
    const names = descriptors.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('keys the registry by the adapter its descriptor names', () => {
    for (const [key, adapter] of createAdapters()) {
      expect(adapter.descriptor.name).toBe(key)
      expect(adapter.tool).toBe(key)
    }
  })

  it('gives every tool a distinct one-glyph mark', () => {
    const marks = descriptors.map((d) => d.mark)
    expect(new Set(marks).size).toBe(marks.length)
    for (const mark of marks) expect(mark).toHaveLength(1)
  })

  it('gives every tool a label and the two commands that fix it', () => {
    for (const d of descriptors) {
      expect(d.label.trim()).not.toBe('')
      expect(d.install.trim()).not.toBe('')
      expect(d.login.trim()).not.toBe('')
    }
  })
})

/*
 * The drift run's second direction (#270) reads every registered adapter's surface. Optional in the contract, so test
 * doubles need not carry one; a shipped adapter without it would be watched in one direction only, silently.
 */
describe('tool surfaces', () => {
  it('every shipped adapter says what its tool offers and what it limits', () => {
    for (const [tool, adapter] of createAdapters()) {
      expect(adapter.surface, `${tool} declares no surface`).toBeDefined()
      expect(adapter.surface!.baseline.version, `${tool} has no recorded baseline`).not.toBe('')
      for (const l of adapter.surface!.limitations) expect(l.measured.trim(), `${tool} ${l.name}`).not.toBe('')
    }
  })
})
