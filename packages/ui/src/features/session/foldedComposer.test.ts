import { describe, expect, it } from 'vitest'
import { COMPOSER_REACH, FOLDED_SLIVER } from './foldedComposer.js'

describe('the folded composer', () => {
  it('shows 32px of its card at rest (owner, 2026-11-06)', () => {
    expect(FOLDED_SLIVER).toBe(32)
  })

  it('is raised from a strip taller than the sliver, so the card\'s own top edge lies inside it', () => {
    expect(COMPOSER_REACH).toBeGreaterThan(FOLDED_SLIVER)
  })
})
