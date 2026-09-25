import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeRunLedger } from '../app-run-ledger.js'
import { ExternalApps, type RuntimeTiming } from '../apps/external/runtime.js'
import { Store } from '../dev-services/store.js'

/**
 * 세션에 앱을 붙이는 테스트(A-5)가 함께 쓰는 세계 — 진짜 런타임, 진짜 앱 프로세스(픽스처),
 * 진짜 실행 기록(host의 main과 같은 이음새 `storeRunLedger`).
 *
 *   p1     신뢰한 프로젝트
 *   p2     신뢰하지 않은 프로젝트
 *   user   사용자 폴더 (`<dataRoot>/apps`) — 언제나 신뢰
 *
 * (테스트 전용 파일이다. 제품 코드는 이것을 임포트하지 않는다)
 *
 * 앱 폴더를 심는 손(`apps/external/test-helpers.ts`)은 **테스트가 넘긴다.** 이 파일은 `.test.ts`가
 * 아니라서 층 규칙(`host-core-blind-to-apps`)을 그대로 받는다 — 코어 쪽 파일이 런타임의 문
 * (`runtime.ts`) 뒤를 임포트하지 않게 규칙을 느슨하게 하는 대신, 테스트 파일이 들고 온다.
 */

/** `apps/external/test-helpers.ts`의 두 손 — 테스트 파일이 그대로 넘긴다 */
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
  /** 픽스처 앱 하나를 심는다 (기본 `--mode attach`). 반환은 앱 폴더 */
  plant(where: 'p1' | 'p2' | 'user', id: string, args?: string[]): string
  /** 그 앱 프로세스가 스스로 적은 기록 */
  records(id: string): Rec[]
  /** `hold` 도구를 풀어 주는 문 파일의 경로 (`--gate`로 넘긴다) */
  gate(id: string): string
  dispose(): Promise<void>
}

export function attachWorld(kit: PlantKit, timing: Partial<RuntimeTiming> = {}): AttachWorld {
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
