import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps, type ExternalAppsDeps, type RuntimeTiming } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'

/**
 * The world shared by tests that attach apps to a session (A-5) — a real runtime, a real app
 * process (a fixture), and a real run record (`storeRunLedger`, the same seam the host's main
 * uses).
 *
 *   p1     a trusted project
 *   p2     an untrusted project
 *   user   the user folder (`<dataRoot>/apps`) — always trusted
 *
 * (A test-only file. Product code never imports it.)
 *
 * Planting app folders (`apps/external/test-helpers.ts`) is **handed in by the test.** This file
 * is not a `.test.ts`, so it is still bound by the layer rule (`host-core-blind-to-apps`) — rather
 * than loosening the rule so that a core-side file could import behind the runtime's door
 * (`runtime.ts`), the test file carries it in instead.
 */

/** The two hands of `apps/external/test-helpers.ts` — passed straight through by the test file */
export type PlantKit = {
  plantApp(parentDir: string, id: string, over?: Record<string, unknown>): string
  PROJECT_APPS: readonly string[]
}

export const FIXTURE_APP = fileURLToPath(new URL('../apps/external/test-fixtures/app.mjs', import.meta.url))

export type Rec = { t: string; pid: number; runId?: string | null; method?: string }

export type AttachWorld = {
  root: string
  dataRoot: string
  roots: { p1: string; p2: string }
  trust: { p1: boolean; p2: boolean }
  store: Store
  rt: ExternalApps
  /** Plants one fixture app (`--mode attach` by default). Returns the app folder */
  plant(where: 'p1' | 'p2' | 'user', id: string, args?: string[]): string
  /** The record that app process wrote about itself */
  records(id: string): Rec[]
  /** The path to the gate file that releases the `hold` tool (passed via `--gate`) */
  gate(id: string): string
  dispose(): Promise<void>
}

export function attachWorld(kit: PlantKit, timing: Partial<RuntimeTiming> = {}, deps: Pick<ExternalAppsDeps, 'shared'> = {}): AttachWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-attach-')))
  const dataRoot = join(root, 'data')
  const roots = { p1: join(root, 'p1'), p2: join(root, 'p2') }
  const logs = join(root, 'fixture-logs')
  for (const d of [dataRoot, roots.p1, roots.p2, logs]) mkdirSync(d)
  const trust = { p1: true, p2: false }
  const store = new Store()
  const rt = new ExternalApps({
    projects: () => [
      { id: 'p1', path: roots.p1, trusted: trust.p1 },
      { id: 'p2', path: roots.p2, trusted: trust.p2 },
    ],
    dataRoot,
    reservedIds: ['control'],
    watchFlushMs: 40,
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
    runs: storeRunLedger(store),
    ...deps,
  })
  rt.refresh()
  const world: AttachWorld = {
    root,
    dataRoot,
    roots,
    trust,
    store,
    rt,
    plant(where, id, args = ['--mode', 'attach']) {
      const parent = where === 'user' ? join(dataRoot, 'apps') : join(roots[where], ...kit.PROJECT_APPS)
      return kit.plantApp(parent, id, {
        server: { command: process.execPath, args: [FIXTURE_APP, '--log', join(logs, `${id}.jsonl`), '--gate', world.gate(id), ...args] },
      })
    },
    records(id) {
      const f = join(logs, `${id}.jsonl`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
    },
    gate: (id) => join(logs, `${id}.gate`),
    async dispose() {
      await rt.dispose()
      store.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  return world
}
