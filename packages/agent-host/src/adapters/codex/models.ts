import type { ModelOption } from '@cc/protocol'
import { homedir } from 'node:os'
import { CodexClient } from './client.js'
import { isUnknownMethod, UNSUPPORTED } from './history.js'

/**
 * 고를 수 있는 모델 목록 (`model/list`).
 *
 * **목록을 우리가 적지 않는다.** codex가 알려주는 것을 그대로 나른다 —
 * 하드코딩하면 새 모델이 나올 때마다 이 앱만 조용히 뒤처진다.
 *
 * 추론 강도도 여기서 함께 온다 (`supportedReasoningEfforts`).
 * 모델마다 단계가 다르므로 모델에 붙여 두어야 "이 조합이 되나?"의 답이 하나가 된다.
 *
 * 계정의 성질이라 cwd를 받지 않는다. 클라이언트를 띄우려면 디렉토리가 필요할 뿐이라
 * 홈을 쓴다 (사용량 읽기와 같은 방식).
 */
/** 페이지 상한. 실제 모델 수를 한참 넘는 값이라, 여기 걸리면 뭔가 잘못된 것이다 */
const MAX_PAGES = 20

/**
 * 커서를 따라 **끝까지** 모은다.
 *
 * 처음엔 첫 페이지만 읽었다. 목록이 짧아 보여도 "이게 다인가 보다" 하고 넘어가게 되는
 * 종류의 버그라 — 사용자가 "다 가져오는 거지?"라고 묻기 전까지 아무도 몰랐다.
 *
 * 페이징을 인자로 받는 순수 함수로 둔다: codex를 띄우지 않고도 "정말 끝까지 도는가"를
 * 검증할 수 있어야, 이 실수를 다시 하면 테스트가 먼저 말해준다.
 */
export async function collectModels(
  fetchPage: (cursor: string | null) => Promise<{ data?: unknown; nextCursor?: unknown }>,
): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchPage(cursor)
    out.push(...toModelOptions(res?.data))
    cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : null
    if (!cursor) return out
  }
  // 조용히 자르지 않는다 — 잘린 목록을 전부인 것처럼 보여주는 게 제일 나쁘다
  throw new Error(`모델이 너무 많아 ${MAX_PAGES}페이지까지만 읽었습니다 (목록이 잘렸습니다)`)
}

export async function listCodexModels(command: string): Promise<ModelOption[]> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd: homedir(), command },
  )
  try {
    await client.request('initialize', {
      clientInfo: { name: 'control-center', title: 'Control Center', version: '0.1.0' },
      capabilities: null,
    })
    client.notify('initialized')
    /*
     * **끝까지 읽는다.** 응답에 nextCursor가 있다 — 첫 페이지만 읽으면
     * 뒤쪽 모델이 조용히 사라진다. 목록이 짧아 보여서 "이게 다인가 보다" 하고
     * 넘어가기 딱 좋은 종류의 버그라, 커서가 null이 될 때까지 돈다.
     *
     * 페이지 수에 상한을 둔다. 서버가 커서를 계속 돌려주는 상황에서
     * 무한히 도는 것보다는 멈추는 편이 낫다 — 대신 **잘렸다고 말한다**.
     */
    return collectModels(async (cursor) => {
      try {
        return await client.request<{ data?: unknown; nextCursor?: unknown }>(
          'model/list',
          cursor ? { cursor } : {},
        )
      } catch (err) {
        throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
      }
    })
  } finally {
    await client.dispose().catch(() => {})
  }
}

/** 응답 → 우리 타입. 순수 함수로 분리해 codex를 띄우지 않고도 포맷 변화를 잡는다 */
export function toModelOptions(data: unknown): ModelOption[] {
  const rows = Array.isArray(data) ? data : []
  const out: ModelOption[] = []
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>
    const id = typeof row.model === 'string' && row.model ? row.model : undefined
    if (!id) continue
    // 기본 목록에서 숨긴 모델은 우리도 숨긴다 — codex가 숨긴 데는 이유가 있다
    if (row.hidden === true) continue
    /*
     * 강도 항목의 실제 모양은 `{ reasoningEffort, description }`이다
     * (generated/v2/ReasoningEffortOption.ts). 처음에 `{ effort }`로 짐작해서 읽었더니
     * 항상 빈 배열이 나왔고 — 그래서 codex 세션에는 강도 셀렉터가 아예 뜨지 않았다.
     * 짐작한 모양으로 테스트까지 써 두는 바람에 통과하기까지 했다.
     * 문자열로 오는 경우도 함께 받아 둔다: 포맷이 바뀌어도 목록이 통째로 비지는 않게.
     */
    const efforts: string[] = []
    for (const e of Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []) {
      const v = typeof e === 'string' ? e : ((e ?? {}) as { reasoningEffort?: unknown }).reasoningEffort
      if (typeof v === 'string' && v) efforts.push(v)
    }
    out.push({
      id,
      label: typeof row.displayName === 'string' && row.displayName ? row.displayName : id,
      description: typeof row.description === 'string' && row.description ? row.description : undefined,
      efforts: [...new Set(efforts)],
      defaultEffort:
        typeof row.defaultReasoningEffort === 'string' && row.defaultReasoningEffort
          ? row.defaultReasoningEffort
          : null,
    })
  }
  return out
}
