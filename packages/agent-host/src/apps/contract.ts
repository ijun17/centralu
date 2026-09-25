import type { z } from 'zod'
import type { AppId, NormalizedEvent, ToolName } from '@cc/protocol'

/*
 * 런타임의 중심 타입 셋은 **여기서 태어난다** (#97).
 *
 * 전에는 sessions/orchestrator-tools.ts가 이것들을 정의하고 이 파일이 재수출했다.
 * 그러면 "앱이 무엇을 부를 수 있는가"의 정본이 앱을 태우는 층이 아니라 그 위에 탄
 * 승객 하나(오케스트레이터)에게 있게 된다 — 그 승객을 지우면 런타임이 컴파일되지
 * 않는다. 오케스트레이터는 런타임의 호출자 중 하나지 주인이 아니다.
 */

/** 세션이 받는 도구 묶음 (#69). 오케스트레이터는 전부, 워크트리 매니저는 부분집합 */
export type ToolProfile = 'orchestrator' | 'manager' | 'scoped'

/** 앱 도구를 부른 주체 — sessionId=null은 사람(UI)이다. 앱이 자기 권한 판정에 쓴다 */
export type AppToolCaller = { sessionId: string | null; profile: ToolProfile | 'human' }

export type ToolOutput = { text: string; isError?: boolean }

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
  /**
   * 세션 물리 원시형 (#80·#81). **타입형이다** — 범용 세션 주조를 주면 앱이
   * 임의 권력의 세션을 만드는 칼자루가 된다 (#72의 생성형 앱까지 보면 특히).
   * 의미(이름·역할문)는 앱이 주고, 능력(시야 강제·박제)은 코어가 강제한다.
   */
  sessions: {
    createCoordinator(opts: {
      name: string
      memberSessionIds: string[]
      roleAppend: string
      /** 열린 이름(#74) — 받는 쪽(manager.createCoordinator)이 원래 ToolName이었다 */
      tool: ToolName
      model?: string
      effort?: string
    }): Promise<{ id: string; name: string }>
  }
}

export type HostAppModule = {
  /** UI 절반과 같은 열린 문자열 (M4 P-1) — 외부 앱도 같은 명부에 서야 한다 */
  id: AppId
  tools?: {
    /** 어느 묶음이 이 도구들을 보는가 — 워커는 어떤 경우에도 아니다 */
    profiles: readonly ToolProfile[]
    /** def.profiles가 있으면 그룹 기본을 덮는다 — 도구마다 시야가 다른 앱(관제)의 요구 */
    defs: readonly { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; profiles?: readonly ToolProfile[] }[]
    run(ctx: HostAppContext, name: string, args: Record<string, unknown>, caller: AppToolCaller): Promise<ToolOutput>
  }
  /**
   * 이벤트 관찰 (#80 체크포인트, #81에서 예측한 계약 성장) — **규칙은 앱의 의견,
   * 관찰 자체는 물리**다. host가 방송하는 모든 이벤트가 켜진 앱에 흐른다.
   * 동기 호출이라 가볍게: 무거운 일은 여기서 하지 말고, 실패는 host가 삼키고 기록한다.
   * app_state_changed는 앱 자신의 산물이라 되돌아오지 않는다 (고리 방지).
   */
  observe?(ctx: HostAppContext, event: NormalizedEvent): void
  /**
   * 기동에 한 번 — **이 앱이 이미 만들어 둔 세션들의 id**를 돌려준다 (사용자 요청 2026-09-09).
   *
   * 소유(appId)는 이제 세션 행에 적히지만, 그 칸이 생기기 전에 만들어진 세션은 비어 있다.
   * 어느 세션이 자기 것인지는 **앱만 안다**(자기 문서의 모양을 아는 것도 앱뿐이다) —
   * 그래서 앱이 말하고 코어가 적는다. 코어는 여전히 그 뜻을 모른다.
   */
  claimSessions?(ctx: HostAppContext): readonly string[]
}

/**
 * 오케스트레이터 MCP 서버의 이름.
 *
 * **화면에 보이는 이름이고, 동시에 신뢰의 열쇠다** — 도구 호출 카드에
 * `mcp__centralu__list_sessions`처럼 뜨고, claude 어댑터의 승인 예외와 codex의
 * elicitation 수락이 둘 다 이 이름으로 판정한다.
 *
 * 한 곳에 두는 이유: 전에는 claude·codex 어댑터에 리터럴이 한 벌씩 있었고,
 * 정작 제안된 서버 이름을 검사해야 하는 매니저는 어느 쪽도 가져올 수 없었다
 * (어댑터를 임포트하면 SDK가 딸려 온다). 열쇠가 여러 벌이면 한 벌만 고치는
 * 사고가 난다 — 여기 한 번 적고 모두가 가져다 쓴다 (#93).
 *
 * **여기(앱 계약)에 사는 이유 (M4 A-1)**: 처음엔 오케스트레이터 도구 정의 옆에 있었다.
 * 외부 앱의 id가 같은 규칙을 따라야 하는데(세션에 붙는 서버 이름이 `app-<id>`다),
 * 앱 런타임은 sessions 층을 임포트할 수 없다 — 규칙이 승객(오케스트레이터)에게 있으면
 * 런타임이 규칙을 두 벌 갖게 된다. #97이 중심 타입을 이 파일로 옮긴 것과 같은 방향이다.
 */
export const ORCHESTRATOR_MCP_NAME = 'centralu'

/**
 * 제안된 MCP 서버 이름이 쓸 수 있는 이름인가 (#93). 어겼으면 사람이 읽을 이유를, 괜찮으면 null.
 *
 * **이름이 들어오는 자리에서 막는다.** 승인된 서버의 이름은 곧 도구 접두어가 되고,
 * 도구 접두어는 승인 예외의 판정 기준이다. 실측한 두 구멍:
 *
 *   centralu      인프로세스 오케스트레이터 서버를 **통째로 갈아치웠다**
 *                 (승인된 서버가 내장 항목 뒤에 펼쳐진다 — 같은 열쇠가 남의 것이 된다)
 *   centralu__pw  도구 이름이 `mcp__centralu__pw__*`가 되어 접두 검사를 통과했다
 *                 → canUseTool을 아예 건너뛰었다
 *
 * 그래서 두 겹이다. 밑줄을 뺀 글자 규칙은 `__`를 만들 수 없게 하고(둘째 구멍),
 * 예약어 검사는 이름 자체를 못 가져가게 한다(첫째 구멍). 예약어를 먼저 보는 것은
 * 나중에 글자 규칙을 느슨하게 고쳐도 이 판정만은 남아 있으라는 뜻이다.
 */
export function mcpServerNameError(name: string): string | null {
  if (name.trim().toLowerCase().startsWith(ORCHESTRATOR_MCP_NAME)) {
    return `"${ORCHESTRATOR_MCP_NAME}"로 시작하는 이름은 이 앱이 쓰는 이름입니다 — 다른 이름으로 제안하세요`
  }
  // 밑줄이 빠진 것이 핵심이다: MCP 도구 이름의 칸막이가 `__`라, 이름에 밑줄을
  // 허용하면 서버 하나가 남의 이름 뒤에 칸을 하나 더 붙일 수 있다
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    return '이름은 소문자·숫자·하이픈으로 32자 이내여야 합니다 (밑줄은 도구 이름의 칸막이라 쓸 수 없습니다)'
  }
  return null
}

