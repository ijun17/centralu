import { describe, expect, it } from 'vitest'
import { KNOWN_UPDATES } from './known-updates.js'
import { ACP_METHODS, ACP_UPDATE_KINDS, missingFromSchema } from './schema-contract.js'

const SOURCES = import.meta.glob<string>('./*.ts', { query: '?raw', import: 'default', eager: true })
const sources = Object.entries(SOURCES)
  .map(([path, text]) => ({ f: path.replace('./', ''), text }))
  .filter(({ f }) => !f.includes('.test') && f !== 'schema-contract.ts')

describe('the ACP names checked against the SDK schema (#2480)', () => {
  it('names every method and update kind that is missing, and nothing when the schema carries them all', () => {
    const all = [...ACP_METHODS.map((m) => `"x-method": "${m}"`), ...ACP_UPDATE_KINDS.map((k) => `"const": "${k}"`)].join('\n')
    expect(missingFromSchema(all)).toEqual([])
    expect(missingFromSchema(all.replace('"x-method": "session/load"', '"x-method": "session/gone"').replace('"const": "plan"', '"const": "plan_v2"'))).toEqual(['session/load', 'plan'])
  })

  it('does not count a name that is only a property key or a value of another kind', () => {
    const all = [...ACP_METHODS.map((m) => `"x-method": "${m}"`), ...ACP_UPDATE_KINDS.map((k) => `"const": "${k}"`)].join('\n')
    const withoutPlan = all.replace('"const": "plan"', '"const": "plan_v2"')
    expect(missingFromSchema(`${withoutPlan}\n"plan": { "type": "object" }\n"x-other": "plan"`)).toEqual(['plan'])
  })

  it('leaves out a vendor method, which no ACP schema holds', () => {
    expect(ACP_UPDATE_KINDS.some((name) => name.includes('/'))).toBe(false)
    expect(ACP_UPDATE_KINDS).toContain('agent_message_chunk')
  })

  it('lists every method the adapter code names, so a new one cannot skip the check', () => {
    const named = new Set(sources.flatMap(({ text }) => [...text.matchAll(/'(session\/[a-z_]+|initialize)'/g)].map((m) => m[1]!)))
    expect([...named].filter((name) => !(ACP_METHODS as readonly string[]).includes(name))).toEqual([])
  })

  it('lists every update kind the wire reads in the known updates', () => {
    const wire = sources.find(({ f }) => f === 'wire.ts')!.text
    const kinds = [...wire.matchAll(/sessionUpdate: z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1]!)
    expect(kinds.length).toBeGreaterThan(10)
    expect(kinds.filter((kind) => !KNOWN_UPDATES.has(kind))).toEqual([])
  })
})
