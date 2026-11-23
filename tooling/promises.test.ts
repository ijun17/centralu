/** `guard/promises`: a code comment that promises later work names its issue or says "dropped" (tooling/promises.ts; #2488) */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanRepository, unownedPromises } from './promises.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('guard/promises', () => {
  it('finds no promise of later work without its issue in the repository', () => {
    const found = scanRepository(ROOT)
    expect(found, `promises of later work with no #N and no "dropped: <why>" in their comment block:\n${found.join('\n')}\n`).toEqual([])
  })

  it('finds a promise in a comment that names no issue, and none in one that does', () => {
    const text = [
      '/**',
      ' * Sent as the old value; a later release sends the new one',
      ' */',
      'export const a = 1',
      '// TODO: move this into the OS layer',
      'const b = 2 // not supported yet',
      '/**',
      ' * A later release removes the old copies',
      ' * (#2481)',
      ' */',
      '// dropped: a later release removes nothing here, the owner kept the copies',
      '// TODO(#2522): recount after the keeper goes',
    ].join('\n')
    expect(unownedPromises('src/x.ts', text)).toEqual(['2: a later release sends', '5: TODO', '6: not supported yet'])
  })

  it('asks the sentence that holds the promise for its issue, not the whole block', () => {
    const text = [
      '// See #12 for why the copy is kept. A later release removes the copy.',
      '// A later release removes the old key, e.g. the one #1141 wrote, once no build reads it (#2481).',
      '// TODO: events are dropped when the queue is full',
      '/*',
      '  a later release drops this table',
      '*/',
    ].join('\n')
    expect(unownedPromises('src/x.ts', text)).toEqual(['1: A later release removes', '3: TODO', '5: a later release drops'])
  })

  it('reads only comments, and not a quotation in one or words that only sound like a promise', () => {
    const text = [
      "const message = 'Linux on arm is not supported yet'",
      '// turns "not supported yet" into "your install is broken"',
      '// the second change comes later than the first; a key added later goes with it',
      '// a todo test is skipped, and a later release\'s failed install keeps the offer',
      '// a delete call must not go by unnoticed when a later version of the vendor\'s tool adds one',
    ].join('\n')
    expect(unownedPromises('src/x.ts', text)).toEqual([])
  })

  it('reads YAML comments by their #, and an issue number there carries the promise', () => {
    expect(unownedPromises('.github/workflows/x.yml', '# TODO: pin this runner\nruns-on: ubuntu-24.04\n')).toEqual(['1: TODO'])
    expect(unownedPromises('.github/workflows/x.yml', '# TODO: pin this runner (#123)\nruns-on: ubuntu-24.04\n')).toEqual([])
  })
})
