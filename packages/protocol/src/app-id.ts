/**
 * 앱 id(= 세션에 붙는 MCP 서버 이름)의 규칙 (#93, M4 A-1·C-1) — **한 벌이다.**
 *
 * host는 매니페스트·제안된 MCP 서버·새 앱을, UI는 "새 앱" 창을 이것으로 판정한다. 전에는 host(apps/contract.ts)에만
 * 있었다. 새 앱 창은 이름에서 id를 지어 보여 주고, 만들기 전에 쓸 수 있는 id인지 말해야 하는데, UI는 host를 임포트할
 * 수 없다 — 두 절반이 함께 읽는 선반은 이 패키지뿐이다. 규칙을 UI에 한 벌 더 적으면 창이 통과시킨 id를 host가
 * 거절하거나(사람은 이유를 두 번 듣는다) 그 반대가 되고, #93에서 배운 대로 느슨한 쪽이 곧 구멍이다. 그래서 **판정**은
 * 여기 한 곳에 두고, 사람이 읽을 **말**은 각자 제 자리에서 붙인다(host는 에이전트와 로그에게, UI는 창 앞의 사람에게).
 *
 * 여기에 없는 판정: 내장 앱의 id(명부는 각 절반이 컴파일해 들고 있다 — 부르는 쪽이 넘긴다), 이미 있는 id(발견은 host만
 * 한다), 신뢰(저장소가 정본이다). 그것들은 host가 만들 때 거절하고, 창은 그 말을 그대로 보인다.
 */

/**
 * 이 머리로 시작하는 이름은 Centralu 자신의 것이다 — 인프로세스 오케스트레이터 서버의 이름. 승인된 서버가 이 이름을
 * 가져가면 내장 서버를 통째로 갈아치웠다(#93 실측).
 */
export const RESERVED_NAME_PREFIX = 'centralu'

/**
 * 외부 앱이 세션에 붙는 서버 이름의 머리 (M4 A-5) — 앱 `notes`는 세션에서 `app-notes`다. 새로 **제안되는** 이름(승인할
 * MCP 서버, 새 앱)은 이 머리로 시작할 수 없다: 승인된 `app-notes` 서버는 앱 `notes`의 대리 서버와 같은 칸에 들어간다.
 */
export const APP_SERVER_PREFIX = 'app-'

/** id 한 칸의 길이 상한 — 글자 규칙(아래)과 같은 수다. 이름에서 id를 지을 때 자르는 자리가 여기다 */
export const APP_ID_MAX_LENGTH = 32

/**
 * 밑줄이 빠진 것이 핵심이다: MCP 도구 이름의 칸막이가 `__`라, 밑줄을 허용하면 서버 하나가 남의 이름 뒤에 칸을 하나 더
 * 붙일 수 있다(`centralu__pw` → `mcp__centralu__pw__*`가 접두 검사를 통과했다, #93).
 */
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 서버 이름·앱 id가 공유하는 규칙에 걸린 까닭 */
export type ServerNameProblem = 'reserved' | 'shape'

/**
 * MCP 서버 이름과 앱 id가 함께 따르는 규칙 (#93). 괜찮으면 null.
 *
 * 예약어를 **먼저** 본다 — 나중에 글자 규칙을 느슨하게 고쳐도 이 판정만은 남아 있으라는 뜻이다. 예약어는 대소문자와
 * 앞뒤 공백을 가리지 않고 본다(`CENTRALU`도 같은 이름으로 읽힐 수 있는 자리가 있다).
 */
export function serverNameProblem(name: string): ServerNameProblem | null {
  if (name.trim().toLowerCase().startsWith(RESERVED_NAME_PREFIX)) return 'reserved'
  if (!NAME_SHAPE.test(name)) return 'shape'
  return null
}

/** 새로 만드는 앱의 id가 걸린 까닭 */
export type NewAppIdProblem = ServerNameProblem | 'server-prefix' | 'builtin'

/**
 * 새로 **제안되는** 이름의 판정 — 위 규칙에 `app-` 머리 금지, 그리고 부르는 쪽이 넘긴 내장 앱의 id. 괜찮으면 null.
 *
 * `app-` 머리는 발견에서는 막지 않는다(손으로 만든 `app-store` 앱은 `app-app-store`로 붙어 겹치지 않는다). 막는 것은
 * 새 이름이 들어오는 자리다 — 새 앱이 `app-app-notes`라는 서버 이름을 가질 까닭이 없고, 승인된 서버가 그 칸을 가져가면
 * 앱의 읽기 전용 주석으로 승인을 건너뛸 수 있다.
 */
export function newAppIdProblem(id: string, builtinIds: readonly string[] = []): NewAppIdProblem | null {
  const base = serverNameProblem(id)
  if (base) return base
  if (id.startsWith(APP_SERVER_PREFIX)) return 'server-prefix'
  if (builtinIds.includes(id)) return 'builtin'
  return null
}
