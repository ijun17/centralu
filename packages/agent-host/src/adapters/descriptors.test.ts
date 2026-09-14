/**
 * The rules that used to live in `@cc/protocol`'s shape.
 *
 * `TOOL_META` was a `Record<ToolName, …>` there, so the compiler guaranteed exactly one
 * entry per tool and a test asserted the rest: that no two tools share a mark, and that the
 * install and login commands are real strings. Moving the values onto the adapters gave up
 * the compiler's half — a descriptor is now just an object each adapter writes for itself —
 * so the assertions have to be made across the whole registry instead, which is the only
 * place that can see every tool at once.
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
