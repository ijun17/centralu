/**
 * Writes docs/theme.schema.json from the token list in packages/protocol/src/theme.ts (#312).
 *
 * The host writes the same schema next to the themes in the data folder at start; this copy is
 * the one people and agents can link to without running the app. A unit test fails when the two
 * drift, and running this is the fix: `pnpm exec tsx scripts/theme-schema.mts`.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { themeFileJsonSchema } from '../packages/protocol/src/theme.js'

const out = fileURLToPath(new URL('../docs/theme.schema.json', import.meta.url))
writeFileSync(out, `${JSON.stringify(themeFileJsonSchema(), null, 2)}\n`)
console.log(`wrote ${out}`)
