/** Every path a feature map names is there (tooling/feature-maps.ts, docs/feature-maps/README.md) */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { missingPaths, staleMaps } from './feature-maps.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('feature maps', () => {
  it('name no repository path that is not there', () => {
    expect(staleMaps(ROOT)).toEqual([])
  })

  it('read a code span from a top folder as a path, and a data-folder file or a bare name as none', () => {
    const there = new Set(['packages/a.ts', 'e2e/b.spec.ts'])
    const text = '`packages/a.ts` (`fn`), `packages/gone.ts`, `e2e/b.spec.ts`, `<data>/stopped.json`, `stopped.json`, `packages/gone.ts`'
    expect(missingPaths(text, (path) => there.has(path))).toEqual(['packages/gone.ts'])
  })
})
