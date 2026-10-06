import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { NormalizedEvent } from '@cc/protocol'
import { seedHeavyStore, type SeedSummary } from '../e2e/fixtures/heavy-store.js'
import { Store } from '../packages/agent-host/src/dev-services/store.js'

/**
 * The perf fixture (`e2e/fixtures/heavy-store.ts`): a measurement is only comparable with another if both ran on
 * the same store, so the same profile and seed must write the same rows, and those rows must be ones the host
 * and the window read the way they read a real store's.
 */

const dirs: string[] = []
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'centralu-heavy-store-'))
  dirs.push(d)
  return join(d, 'data')
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Every row of every session, full payloads (paths in them name the folder, so compare seeds made in one folder) */
function digest(s: SeedSummary): string {
  const store = new Store(s.db)
  try {
    const h = createHash('sha256')
    for (const session of s.sessions) {
      for (const m of store.loadMessagesFrom(session.id, 0, 1_000_000, { full: true })) {
        h.update(JSON.stringify(m))
      }
    }
    return h.digest('hex')
  } finally {
    store.close()
  }
}

describe('heavy-store fixture', () => {
  const a = seedHeavyStore(fresh(), 'small', 1)

  it('writes the same rows for the same seed, and other rows for another', () => {
    const dir = fresh()
    const once = (seed: number) => {
      rmSync(dir, { recursive: true, force: true })
      return digest(seedHeavyStore(dir, 'small', seed))
    }
    const first = once(1)
    expect(once(1)).toBe(first)
    expect(once(2)).not.toBe(first)
  })

  it('has the real store’s mix: calls and results dominate, then texts, then reasoning', () => {
    const k = a.rowsByKind
    expect(k.tool_call).toBe(k.tool_result)
    // The owner's store: 61k calls, 20k texts, 10k reasoning
    expect(k.tool_call! / k.text!).toBeGreaterThan(2)
    expect(k.tool_call! / k.text!).toBeLessThan(4.5)
    expect(k.reasoning! / k.tool_call!).toBeGreaterThan(0.08)
    expect(k.reasoning! / k.tool_call!).toBeLessThan(0.3)
    expect(a.images).toBe(2)
    expect(a.subagentSteps).toBeGreaterThan(0)
  })

  it('stores rows the host reads back as events, with the image bytes on disk', () => {
    const store = new Store(a.db)
    try {
      expect(
        store
          .listSessions()
          .map((s) => s.id)
          .sort(),
      ).toEqual(a.sessions.map((s) => s.id).sort())
      expect(store.listGridView()).toHaveLength(4)
      const rows = store.loadMessagesFrom(a.longSessionId, 0, 1_000_000)
      expect(rows).toHaveLength(a.sessions[0]!.rows)
      for (const r of rows) {
        if (r.role === 'user') continue
        expect(NormalizedEvent.safeParse(r.payload).success, `${r.kind} at ${r.seq}`).toBe(true)
      }
      const images = rows.filter((r) => r.kind === 'image').map((r) => (r.payload as { path: string }).path)
      expect(images).toHaveLength(2)
      for (const path of images) expect(existsSync(path), path).toBe(true)
      // A page as the window asks for it carries cards, not the tool's output
      const page = store.loadMessages(a.longSessionId, 100)
      expect(page.some((r) => r.kind === 'tool_result' && 'output' in (r.payload as object))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('refuses a folder that already holds a store', () => {
    expect(() => seedHeavyStore(a.dataDir, 'small', 1)).toThrow(/already exists/)
  })
})
