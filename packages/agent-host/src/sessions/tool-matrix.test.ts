import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ToolProfile } from '../apps/contract.js'
import { APP_ACCESS_TOOLS, DELEGATE_TOOLS, ORCHESTRATOR_TOOLS, READER_TOOLS, profileAllows, toolDefsFor } from './orchestrator-tools.js'

/**
 * The profile × tool matrix in docs/security-boundaries.md (#382) is the code's, not a copy that drifts: every
 * tool Centralu serves has a row, every profile a column, and each cell says what `profileAllows` (execution)
 * and `toolDefsFor` (what the session sees) decide. The "none" column is the sessions that get no server.
 */
const doc = readFileSync(fileURLToPath(new URL('../../../../docs/security-boundaries.md', import.meta.url)), 'utf8')

function matrix(): { profiles: string[]; rows: Map<string, string[]> } {
  const block = /<!-- tool-matrix:start -->\n([\s\S]*?)\n<!-- tool-matrix:end -->/.exec(doc)?.[1]
  if (!block) throw new Error('docs/security-boundaries.md has no tool-matrix block')
  const lines = block.split('\n').map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  const [header, , ...body] = lines
  const rows = new Map<string, string[]>()
  for (const cells of body) rows.set(cells[0]!.replace(/`/g, ''), cells.slice(1))
  return { profiles: header!.slice(1), rows }
}

const PROFILES: ToolProfile[] = ['orchestrator', 'manager', 'scoped', 'builder', 'reader']
const ALL_TOOLS = [...new Set([...ORCHESTRATOR_TOOLS, ...READER_TOOLS, ...DELEGATE_TOOLS, ...APP_ACCESS_TOOLS].map((t) => t.name))]

describe('the tool matrix in docs/security-boundaries.md (#382)', () => {
  const { profiles, rows } = matrix()

  it('has a column for every profile, and one for sessions with none', () => {
    expect(profiles).toEqual([...PROFILES, 'none'])
  })

  it('has a row for every tool Centralu serves, and no other', () => {
    expect([...rows.keys()].sort()).toEqual([...ALL_TOOLS].sort())
  })

  it('says what profileAllows and toolDefsFor decide, cell by cell', () => {
    const wrong: string[] = []
    for (const [name, cells] of rows) {
      PROFILES.forEach((p, i) => {
        const said = cells[i] === 'yes'
        if (cells[i] !== 'yes' && cells[i] !== '—') wrong.push(`${name} × ${p}: "${cells[i]}" is neither yes nor —`)
        if (profileAllows(p, name) !== said) wrong.push(`${name} × ${p}: the table says ${said ? 'yes' : '—'}, profileAllows says ${!said ? 'yes' : '—'}`)
        if (toolDefsFor(p).some((t) => t.name === name) !== said) wrong.push(`${name} × ${p}: the table and what the session is shown (toolDefsFor) differ`)
      })
      if (cells[PROFILES.length] !== '—') wrong.push(`${name} × none: a session with no profile gets no Centralu server`)
    }
    expect(wrong).toEqual([])
  })
})
