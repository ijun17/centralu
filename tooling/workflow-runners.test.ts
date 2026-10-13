import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const directory = new URL('../.github/workflows/', import.meta.url)
const workflows = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name)).sort()

describe('workflow runner images change only when explicitly upgraded', () => {
  it('discovers the repository workflows', () => {
    expect(workflows.length).toBeGreaterThan(0)
  })

  it.each(workflows)('%s has no floating hosted runner labels', (name) => {
    // Scan every live line, not only runs-on: labels can come from a matrix axis,
    // include entry, YAML alias or expression. Comments may explain the old labels.
    const floating = readFileSync(new URL(name, directory), 'utf8').split('\n')
      .flatMap((line, index) => {
        const config = line.replace(/(^|\s)#.*$/, '')
        return /\b(?:ubuntu|macos|windows)-latest\b/.test(config)
          ? [`${name}:${index + 1}: ${config.trim()}`]
          : []
      })
    expect(floating, 'Pin runner images, including matrix values, to explicit OS versions').toEqual([])
  })
})
