import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import type { AgentTokens, AppRunListed, AppRunRow, RunLedger } from './runs.js'
import type { BrokerHost } from './desk.js'

/**
 * Shared helpers for external-app tests — plant an app folder, and wait until a condition holds.
 * (Test-only file. The runtime never imports this.)
 */

export const PROJECT_APPS = ['.centralu', 'apps'] as const

/** Writes `<root>/<...parent>/<id>/centralu.app.json`. If `over` is null, writes the raw string verbatim. */
export function plantApp(
  parentDir: string,
  id: string,
  over: Record<string, unknown> = {},
  raw?: string,
): string {
  const dir = join(parentDir, id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    id,
    name: `App ${id}`,
    version: '0.1.0',
    description: `test app ${id}`,
    server: { command: process.execPath, args: ['server.mjs'] },
    ...over,
  }
  writeFileSync(join(dir, MANIFEST_FILE), raw ?? JSON.stringify(manifest, null, 2))
  return dir
}

/** Waits for something that happens "soon", like an fs watch. If it does not settle in time, fails with the last value. */
export async function until<T>(read: () => T, ok: (v: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = read()
  while (!ok(v)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting; last value: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 25))
    v = read()
  }
  return v
}

/**
 * A run ledger that lives only in memory — used by tests at this layer, which cannot import the
 * store (`host-app-runtime-physics-only` applies to test files too). The store-side seam
 * (`storeRunLedger`) is exercised against the real store by the core-side tests.
 */
export function memoryLedger(): RunLedger & { rows: AppRunRow[]; failures: { runId: string; args: string; result: string | null }[] } {
  const rows: AppRunRow[] = []
  const failures: { runId: string; args: string; result: string | null }[] = []
  const tokens = new Map<string, AgentTokens>()
  return {
    rows,
    failures,
    begin: (r) => void rows.push({ ...r }),
    end: (id, { tokens: t, ...e }) => {
      const r = rows.find((x) => x.id === id)
      if (r) Object.assign(r, e)
      if (t) tokens.set(id, t)
    },
    link: (id, sessionId) => {
      const r = rows.find((x) => x.id === id)
      if (r) r.sessionId = sessionId
    },
    keepFailure: (f) => void failures.push({ runId: f.runId, args: f.args, result: f.result }),
    list: (projectId, appId, limit): AppRunListed[] =>
      rows
        .filter((r) => r.appId === appId && r.projectId === projectId)
        .reverse()
        .slice(0, limit)
        .map((r) => ({ ...r, tokens: tokens.get(r.id) ?? null, failure: null })),
    agentUse: (projectId, appId, since) => {
      const ran = rows.filter((r) => r.appId === appId && r.projectId === projectId && r.kind === 'broker' && r.tool === 'run_agent' && r.sessionId && r.createdAt >= since)
      const counted = ran.map((r) => tokens.get(r.id)).filter((t) => !!t)
      return {
        runs: ran.length,
        durationMs: ran.reduce((n, r) => n + (r.durationMs ?? 0), 0),
        tokens: counted.length ? { input: counted.reduce((n, t) => n + t.input, 0), output: counted.reduce((n, t) => n + t.output, 0) } : null,
      }
    },
    prune: () => 0,
    settleUnfinished: () => 0,
  }
}

/**
 * The host body (D) that tests use — fills in only what the test supplies, and everything else
 * rejects with "not part of this test". If an unused-in-this-test body silently succeeded instead,
 * the test would never see a call it should not have received.
 */
export function fakeBrokerHost(over: Partial<BrokerHost>): BrokerHost {
  const never = (what: string) => () => Promise.reject(new Error(`${what} is not part of this test`))
  return {
    defaultAgentTool: () => 'claude',
    agentLabel: (tool) => (tool === 'claude' ? 'Claude Code' : tool),
    runAgent: never('runAgent'),
    hostData: never('hostData'),
    // A test that does not ask about this is treated as if the person allowed it immediately — a
    // test that checks the asking replaces this in place
    askCapability: async () => 'allow',
    ...over,
  }
}
