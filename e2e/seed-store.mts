/**
 * Seeds a store for measuring: `pnpm seed:store <empty folder> [--profile small|owner|stress] [--seed N]`
 *
 * The folder becomes a data folder (`store.db`, `attachments/`, `projects/`). Serve it with
 * `CC_DATA_DIR=<folder> pnpm host --db <folder>/store.db`. The fixture is `e2e/fixtures/heavy-store.ts`;
 * `pnpm perf:memory` seeds its own and measures against it.
 *
 * Based on measure/seed.mts by GyuHo123 in #400.
 */
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { PROFILES, seedHeavyStore, type StoreProfile } from './fixtures/heavy-store.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { profile: { type: 'string', default: 'owner' }, seed: { type: 'string', default: '1' } },
})
const dir = positionals[0]
const profile = values.profile as StoreProfile
if (!dir || !(profile in PROFILES)) {
  console.error(
    `usage: seed-store.mts <empty folder> [--profile ${Object.keys(PROFILES).join('|')}] [--seed N]`,
  )
  process.exit(2)
}
const target = resolve(dir)
const real = resolve(homedir(), '.centralu')
if (target === real || target.startsWith(real + sep)) {
  console.error(`refusing to seed the real data folder (${real})`)
  process.exit(2)
}

const t0 = performance.now()
const s = seedHeavyStore(target, profile, Number(values.seed))
const rows = Object.values(s.rowsByKind).reduce((a, b) => a + b, 0)
console.log(
  JSON.stringify(
    { ...s, rows, seconds: Math.round((performance.now() - t0) / 100) / 10, sessions: s.sessions.length },
    null,
    2,
  ),
)
