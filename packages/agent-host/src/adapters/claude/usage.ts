import type { UsageSnapshot, UsageWindow } from '@cc/protocol'

/**
 * Claude 사용량·한도 (FR-9).
 *
 * **구독 한도만 다룬다.** extra_usage(추가 결제 크레딧)는 범위 밖이라 읽지 않는다.
 *
 * 이 API는 SDK가 이름으로 불안정을 표시해 두었다
 * (usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).
 * 그래도 쓰는 이유: 파일을 뒤지는 것보다 낫다. 사라지면 호출이 던지므로 우리가 **알 수 있고**,
 * 그때는 그 카드만 접으면 된다. 조용히 틀린 값을 보여주는 쪽이 훨씬 나쁘다.
 *
 * 실측한 창 (max 플랜):
 *   kind=session      group=session   8%  → 5시간 창
 *   kind=weekly_all   group=weekly   15%  → 주간 전체
 *   kind=weekly_scoped group=weekly   6%  → 주간 모델별
 */

const LABEL: Record<string, string> = {
  session: '5시간',
  weekly_all: '주간',
  weekly_scoped: '주간 (모델별)',
}

type RawLimit = {
  kind?: unknown
  group?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 응답 → 우리 모양. 도구 타입을 밖으로 내보내지 않기 위해 여기서 끝낸다 */
export function toSnapshot(raw: unknown): UsageSnapshot {
  const res = (raw ?? {}) as { subscription_type?: unknown; rate_limits?: { limits?: unknown } | null }
  const limits = Array.isArray(res.rate_limits?.limits) ? (res.rate_limits.limits as RawLimit[]) : []

  const windows: UsageWindow[] = []
  for (const l of limits) {
    const kind = str(l.kind)
    const percent = num(l.percent)
    if (!kind || percent === null) continue
    const model = str(l.scope?.model?.display_name) ?? str(l.scope?.model?.id)
    windows.push({
      id: kind,
      label: LABEL[kind] ?? kind,
      percent: Math.max(0, Math.min(100, percent)),
      resetsAt: str(l.resets_at),
      scope: model,
    })
  }

  return {
    plan: str(res.subscription_type),
    windows,
    // Claude의 플랜 한도에는 일간 창이 없다 (실측). 비워 두면 UI가 그 줄을 접는다.
    daily: [],
  }
}

/** SDK Query 중 사용량 부분만 */
export type UsageQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>
}

export const UNSUPPORTED =
  '설치된 Claude Code SDK가 사용량 조회를 지원하지 않습니다 (SDK 업데이트가 필요합니다)'

export async function readUsage(q: UsageQuery | null): Promise<UsageSnapshot> {
  const fn = q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
  if (typeof fn !== 'function') throw new Error(UNSUPPORTED)
  return toSnapshot(await fn.call(q))
}
