import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflows = new URL('../.github/workflows/', import.meta.url)
const actions = new URL('../.github/actions/', import.meta.url)

describe('workflow dependencies are immutable', () => {
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    it(`${name} pins every remote Action to a full commit SHA`, () => {
      const source = readFileSync(new URL(name, workflows), 'utf8')
      const references = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)]
      expect(references.length).toBeGreaterThan(0)
      for (const reference of references) {
        // This repository's own composite action (its remote Actions are pinned inside it, checked below)
        const local = reference[1]!.match(/^\.\/(\.github\/actions\/[\w-]+)$/)
        if (local) {
          expect(existsSync(new URL(`../${local[1]}/action.yml`, import.meta.url)), `${name}: ${reference[1]}`).toBe(true)
          continue
        }
        expect(reference[1], `${name}: ${reference[0].trim()}`).toMatch(
          /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
        )
      }
    })
  }

  for (const name of readdirSync(actions)) {
    it(`the composite action ${name} pins every remote Action to a full commit SHA`, () => {
      const source = readFileSync(new URL(`${name}/action.yml`, actions), 'utf8')
      const references = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)]
      expect(references.length).toBeGreaterThan(0)
      for (const reference of references) expect(reference[1]).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
    })
  }
})
