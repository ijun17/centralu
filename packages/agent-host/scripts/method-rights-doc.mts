/**
 * Writes docs/generated/method-rights.md: what the limited credential may call, read off `METHOD_RIGHTS`
 * (src/transport/method-rights-doc.ts, #1405). Run after changing a method's class: `pnpm docs:rights`.
 * A unit test fails while the committed file and the table disagree.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMethodRightsDoc } from '../src/transport/method-rights-doc.js'

const out = fileURLToPath(new URL('../../../docs/generated/method-rights.md', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, renderMethodRightsDoc())
console.log(`wrote ${out}`)
