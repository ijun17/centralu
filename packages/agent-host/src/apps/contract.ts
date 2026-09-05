import type { z } from 'zod'
import type { NormalizedEvent } from '@cc/protocol'
import type { ToolProfile, ToolOutput } from '../sessions/orchestrator-tools.js'

/**
 * 앱의 host 쪽 계약 (#81) — **통행증의 절반**.
 *
 * 앱은 코어를 모르는 채(정확히는: 이 파일이 주는 문으로만) 오케스트레이터 도구와
 * 자기 상태를 얻는다. 반대 방향은 registry 한 줄뿐이다 — 코어가 앱을 모르는 것이
 * 실험을 뜯어낼 수 있게 하는 그 격리다 (완전 격리가 아니라 단방향+소유권).
 *
 * 도구 이름은 반드시 `<id>_` 접두를 갖는다 — 사람이 호출 카드에서 출처를 읽는
 * 이름 규약이고, 판정의 정본은 접두가 아니라 등록 명부다 (orchestrator-tools.ts).
 */
export type HostAppContext = {
  /** 네임스페이스 KV — 물리적으로 app_settings의 `app:<id>:<key>` (스킬·MCP 제안 선례) */
  kv: {
    get<T>(key: string): T | null
    set(key: string, value: unknown): void
  }
  /** 검증·표시용 최소 세션 조회 — 읽기 전용이고, 이것이 앱이 세션에 대해 아는 전부다 */
  sessionSummary(id: string): { name: string; state: string; projectId: string | null } | null
  /** `app_state_changed` 방송 — UI는 apps.state로 다시 읽는다 (일부러 거친 이벤트) */
  emitChanged(): void
}

export type HostAppModule = {
  id: string
  tools?: {
    /** 어느 묶음이 이 도구들을 보는가 — 워커는 어떤 경우에도 아니다 */
    profiles: readonly ToolProfile[]
    defs: readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[]
    run(ctx: HostAppContext, name: string, args: Record<string, unknown>): Promise<ToolOutput>
  }
  /**
   * 이벤트 관찰 (#80 체크포인트, #81에서 예측한 계약 성장) — **규칙은 앱의 의견,
   * 관찰 자체는 물리**다. host가 방송하는 모든 이벤트가 켜진 앱에 흐른다.
   * 동기 호출이라 가볍게: 무거운 일은 여기서 하지 말고, 실패는 host가 삼키고 기록한다.
   * app_state_changed는 앱 자신의 산물이라 되돌아오지 않는다 (고리 방지).
   */
  observe?(ctx: HostAppContext, event: NormalizedEvent): void
}
