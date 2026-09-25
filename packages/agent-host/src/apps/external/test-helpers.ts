import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import type { AgentTokens, AppRunListed, AppRunRow, RunLedger } from './runs.js'
import type { BrokerHost } from './desk.js'

/**
 * 외부 앱 테스트가 함께 쓰는 손 — 앱 폴더를 심고, 조건이 설 때까지 기다린다.
 * (테스트 전용 파일이다. 런타임은 이것을 임포트하지 않는다)
 */

export const PROJECT_APPS = ['.centralu', 'apps'] as const

/** `<root>/<...parent>/<id>/centralu.app.json`을 쓴다. over가 null이면 원문 문자열을 쓴다 */
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

/** fs 감시처럼 "곧" 일어나는 일을 기다린다. 시간 안에 안 서면 마지막 값을 들고 실패한다 */
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
 * 메모리에 사는 실행 기록 — 저장소를 임포트할 수 없는 이 층의 시험이 쓴다(`host-app-runtime-physics-only`는 시험 파일에도
 * 걸린다). 저장소 쪽 이음새(`storeRunLedger`)는 코어 쪽 시험이 진짜 저장소로 본다.
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
 * 시험이 쓰는 host의 몸통(D) — 시험이 준 것만 채우고 나머지는 "이 시험에서는 부르지 않는다"로 던진다. 부르지 않을 몸통을
 * 조용히 성공시키면, 부르지 말아야 할 때 불린 것을 시험이 못 본다.
 */
export function fakeBrokerHost(over: Partial<BrokerHost>): BrokerHost {
  const never = (what: string) => () => Promise.reject(new Error(`${what} is not part of this test`))
  return {
    defaultAgentTool: () => 'claude',
    agentLabel: (tool) => (tool === 'claude' ? 'Claude Code' : tool),
    runAgent: never('runAgent'),
    hostData: never('hostData'),
    // 묻지 않는 시험은 사람이 곧바로 허락한 것으로 친다 — 묻는 것을 보는 시험은 이 자리를 갈아 끼운다
    askCapability: async () => 'allow',
    ...over,
  }
}
