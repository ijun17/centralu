import { createHash } from 'node:crypto'

/**
 * 실행 기록의 모양과 규칙 (M4 A-6).
 *
 * 기록을 **어디에** 두는지는 런타임이 모른다 — 모양(`RunLedger`)만 선언하고, host가 저장소로
 * 채운다(main.ts). **무엇을** 남기는지는 여기서 정한다: 인자는 요약과 해시만, 비밀 값은 어디에도
 * 싣지 않고, 실패한 호출만 원문을 최근 몇 건 둔다.
 */

/** 보관 기간 — 기동마다 이보다 오래된 기록을 걷는다 */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 앱마다 원문을 남기는 실패의 수 */
export const FAILURES_KEPT = 20
/** 인자 요약의 길이 — 기록 화면의 한 줄 */
export const SUMMARY_CHARS = 200

export type AppRunRow = {
  id: string
  projectId: string | null
  appId: string
  tool: string
  callerKind: 'view' | 'session' | 'app'
  callerSessionId: string | null
  parentRunId: string | null
  status: 'running' | 'ok' | 'error' | 'cancelled' | 'rejected'
  durationMs: number | null
  argsDigest: string
  argsSummary: string
  error: string | null
  createdAt: number
}

/** 읽어 온 한 줄 — 저장소는 글자로 돌려준다(열린 문자열), 모양은 프로토콜이 가린다 */
export type AppRunListed = Omit<AppRunRow, 'callerKind' | 'status'> & {
  callerKind: string
  status: string
  failure: { args: string; result: string | null } | null
}

export type RunLedger = {
  begin(row: AppRunRow): void
  end(id: string, end: { status: AppRunRow['status']; durationMs: number; error: string | null }): void
  keepFailure(f: { runId: string; projectId: string | null; appId: string; args: string; result: string | null; createdAt: number }, keep: number): void
  list(projectId: string | null, appId: string, limit: number): AppRunListed[]
  prune(before: number): number
  settleUnfinished(error: string): number
}

/**
 * 키 순서를 고정한 JSON. 같은 인자가 키 순서만 달라 다른 해시가 되면 "같은 입력으로 또
 * 실패했다"를 셀 수 없다.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/**
 * 인자 → 기록에 남길 것. **가린 뒤에** 요약하고 해시한다: 해시도 입력의 흔적이다 — 짧은 비밀이
 * 든 인자의 해시는 사전 대입으로 되짚을 수 있다.
 */
export function describeArgs(args: unknown, redact: (t: string) => string): { json: string; digest: string; summary: string } {
  const json = redact(canonicalJson(args))
  const digest = createHash('sha256').update(json).digest('hex')
  const summary = json.length > SUMMARY_CHARS ? `${json.slice(0, SUMMARY_CHARS)}…` : json
  return { json, digest, summary }
}
