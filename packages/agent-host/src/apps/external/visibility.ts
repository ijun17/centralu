import type { Tool } from '@modelcontextprotocol/client'

/**
 * 도구 공개 범위 (M4 A-4, MCP Apps `_meta.ui.visibility`).
 *
 *   model  에이전트의 도구 목록에 오른다 — 세션이, 그리고 다른 앱이(D-2) 부른다
 *   app    그 앱의 화면이 부른다
 *
 * 없으면 둘 다다(규격의 기본값). 지키는 것은 **호스트의 의무**다 — 서버는 누가 불렀는지 구별할
 * 수 없다(ext-apps #746). 그래서 판정은 모든 호출이 지나는 한 자리(`ExternalApps.call`)에서 한다.
 */
export type Audience = 'model' | 'app'

export const DEFAULT_VISIBILITY: readonly Audience[] = ['model', 'app']

/**
 * 도구 하나의 공개 범위. 칸이 **있는데 모양이 틀리면 거절한다** — 없는 것과 같게 읽어 기본값
 * (둘 다)을 주면, `["app"]`을 쓰려다 틀린 도구가 에이전트에게 열린다. 틀린 쪽이 닫히게 둔다.
 */
export function visibilityOf(tool: Tool): { ok: true; visibility: Audience[] } | { ok: false; error: string } {
  const ui = (tool._meta as { ui?: unknown } | undefined)?.ui
  if (ui === undefined) return { ok: true, visibility: [...DEFAULT_VISIBILITY] }
  if (ui === null || typeof ui !== 'object') return { ok: false, error: `${tool.name}: _meta.ui는 객체여야 합니다` }
  const v = (ui as { visibility?: unknown }).visibility
  if (v === undefined) return { ok: true, visibility: [...DEFAULT_VISIBILITY] }
  if (!Array.isArray(v) || !v.every((x) => x === 'model' || x === 'app')) {
    return { ok: false, error: `${tool.name}: _meta.ui.visibility는 "model"·"app"의 배열이어야 합니다 (받은 값: ${JSON.stringify(v)})` }
  }
  return { ok: true, visibility: [...new Set(v as Audience[])] }
}
