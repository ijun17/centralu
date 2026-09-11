import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflows = new URL('../.github/workflows/', import.meta.url)

describe('workflow dependencies are immutable', () => {
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    it(`${name} pins every remote Action to a full commit SHA`, () => {
      const source = readFileSync(new URL(name, workflows), 'utf8')
      const references = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)]
      expect(references.length).toBeGreaterThan(0)
      for (const reference of references) {
        expect(reference[1], `${name}: ${reference[0].trim()}`).toMatch(
          /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
        )
      }
    })
  }
})
