/**
 * Writes docs/generated/schema.md: the store's tables as a new install has them, read off a real `Store`
 * (src/dev-services/schema-doc.ts). Run after a migration that changes the schema: `pnpm docs:schema`.
 * A unit test fails while the committed file and the migrations disagree.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSchemaDoc } from '../src/dev-services/schema-doc.js'

const out = fileURLToPath(new URL('../../../docs/generated/schema.md', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, renderSchemaDoc())
console.log(`wrote ${out}`)
