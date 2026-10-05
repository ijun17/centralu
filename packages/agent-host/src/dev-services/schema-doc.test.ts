import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSchema, renderSchemaDoc } from './schema-doc.js'

const docs = (p: string) => readFileSync(fileURLToPath(new URL(`../../../../docs/${p}`, import.meta.url)), 'utf8')

/** The table names in a concept doc's "Where it is stored" lists. A table named in passing elsewhere has no concept */
function storedTables(doc: string, heading: string): Set<string> {
  const lists = [...doc.matchAll(new RegExp(`^${heading}:\\n\\n((?:- .*\\n(?:  .*\\n)*)+)`, 'gm'))].map((m) => m[1]!)
  return new Set(lists.flatMap((l) => [...l.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]!)))
}

describe('the domain model documents', () => {
  const schema = readSchema()
  const tables = schema.tables.map((t) => t.name)

  it('docs/generated/schema.md is what the migrations produce (run `pnpm docs:schema` after changing the schema)', () => {
    expect(docs('generated/schema.md')).toBe(renderSchemaDoc(schema))
  })

  it('gives every stored table a concept in docs/domain-model.md and its Korean mirror', () => {
    const en = storedTables(docs('domain-model.md'), 'Where it is stored')
    const ko = storedTables(docs('domain-model.ko.md'), '저장되는 곳')
    expect(tables.filter((t) => !en.has(t)), 'tables no "Where it is stored" list in docs/domain-model.md names').toEqual([])
    expect(tables.filter((t) => !ko.has(t)), 'tables no "저장되는 곳" list in docs/domain-model.ko.md names').toEqual([])
  })
})
