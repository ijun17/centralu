import type { ModelOption } from '@cc/protocol'

/** SDK Query 중 모델 목록에 필요한 부분만 (외부 타입은 어댑터 밖으로 안 나간다) */
export type ModelQuery = {
  supportedModels(): Promise<
    {
      value: string
      displayName?: string
      description?: string
      supportsEffort?: boolean
      supportedEffortLevels?: string[]
    }[]
  >
}

/**
 * 고를 수 있는 모델 목록 (`supportedModels()`).
 *
 * **목록을 우리가 적지 않는다.** SDK가 알려주는 것을 그대로 나른다.
 * 하드코딩하고 있었더니 Fable이 나왔는데 고를 수가 없었다 — 도구가 올라가도
 * 이 앱만 제자리인 그 상황을 만들지 않는다.
 *
 * 추론 강도도 모델마다 지원 여부와 단계가 다르므로 여기서 함께 받는다.
 */
export async function readClaudeModels(q: ModelQuery): Promise<ModelOption[]> {
  const rows = await q.supportedModels()
  return rows.map((m) => ({
    id: m.value,
    label: m.displayName || m.value,
    description: m.description || undefined,
    // supportsEffort가 false면 단계가 실려 와도 무시한다 — 답이 둘이면 안 된다
    efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
    defaultEffort: null,
    // claude에는 속도 티어가 없다 (SDK에 대응 개념 없음 — 실측)
    tiers: [],
  }))
}
