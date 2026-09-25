/**
 * 에이전트에게 넘기는 글의 틀 — 앱이 쓴 글, 앱에서 사람이 쓴 글, 앱의 오류 (#120, M4 B-4·C-5·C-6).
 *
 * 틀을 짓는 것은 host다. 여기 있는 이유는 하나 — e2e가 도는 목(platform/mock)이 **같은 틀**로 만드는 세션에 말을
 * 넣어야 화면이 실물과 같은 것을 보인다. 목이 틀을 흉내 내어 한 벌 더 적으면, 화면 시험은 host가 짓지 않는 글을 보고
 * 초록이 된다. 두 절반이 함께 임포트할 수 있는 선반은 이 패키지뿐이다(app-id.ts와 같은 까닭).
 *
 * 틀의 규칙은 #120의 그것 그대로다: 머리말은 `[Centralu]`로 시작하는 한 줄이고, 그 줄에 끼우는 남의 문자열(앱 이름,
 * 도구 이름, 앱이 준 오류)은 한 줄 칸(frameField)을 받는다 — 줄바꿈 하나로 가짜 칸을 틀 안에 그려 넣지 못하게.
 */

/**
 * 틀의 한 줄짜리 칸에 남의 문자열을 끼울 때 (#120).
 *
 * 세션 이름은 첫 마디에서 자동으로 붙고 프로젝트 이름도 우리가 쓴 글이 아니다. 앱 이름은 매니페스트를 쓴 사람의 글이다.
 * 줄바꿈 하나면 `세션: …` 한 줄이 여러 줄이 되어 `사람:` 같은 가짜 칸을 틀 안에 그려 넣을 수 있다. 제어 문자와 형식
 * 문자를 공백 하나로 접고, 길면 자른다 — 틀의 모양은 틀을 쓰는 쪽이 지킨다.
 */
export function frameField(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim()
  return flat.length > 120 ? flat.slice(0, 120) + '…' : flat
}

/** 앱의 실행 하나가 어떻게 끝났나 — 머리말이 말하는 것은 성공이 아닌 결말뿐이다 */
export type BuilderRunFact = {
  tool: string
  callerKind: 'view' | 'session' | 'app'
  status: 'running' | 'error' | 'cancelled' | 'rejected'
  error: string | null
}

/**
 * "여기를 고쳐 줘" 줄(C-5)의 말에 붙는 사실 — 어느 앱, 어느 화면, 그리고 앱이 지금 어떤지. host가 제 기록(앱 목록,
 * 화면 인스턴스, 실행 기록)에서 채운다. 부른 쪽(UI)이 적어 보낸 사실은 싣지 않는다: 머리말이 말하는 것은 host가 아는
 * 사실이어야 만드는 에이전트가 믿고 쓴다.
 */
export type BuilderRequestFacts = {
  app: { appId: string; name: string }
  /** 사람이 보던 화면 — 고정 화면은 home 도구가 연 화면이다. 모르면 null */
  screen: { tool: string; resourceUri: string } | null
  /** 앱이 멈춰 있다 — 죽었거나(crashed) 연달아 실패해 멈췄다(failed). 까닭은 첫 줄만 */
  stopped: { status: 'crashed' | 'failed'; reason: string | null } | null
  /** 앱의 마지막 실행이 성공이 아니었다 — 성공이면 null (사람이 "이게 안 된다"고 할 때 가장 가까운 증거다) */
  latestRun: BuilderRunFact | null
}

const CALLER: Record<BuilderRunFact['callerKind'], string> = { view: 'its view', session: 'a session', app: 'another app' }
const ENDED: Record<BuilderRunFact['status'], string> = {
  running: 'is still running',
  error: 'failed',
  cancelled: 'was cancelled',
  rejected: 'was refused',
}

/**
 * 앱 화면 아래 입력줄에서 사람이 쓴 말을 그 앱의 만드는 세션에 넘기는 모양 (M4 C-5).
 *
 * 앱이 보낸 말(`appMessageFrame`)과 달리 **쓴 것은 사람이다** — 본문은 지시이므로 인용으로 가두지 않는다. 머리말은
 * 그 말이 어디서 왔는지를 말한다: 어느 앱의 어느 화면을 보며 썼는지, 그리고 앱이 지금 멈춰 있거나 마지막 실행이
 * 실패했으면 그 사실. "이 버튼이 안 된다"는 말은 그 실패와 함께 와야 만드는 에이전트가 재현부터 시작하지 않는다.
 * 머리말은 한 줄이다 — 첫 줄 뒤는 모두 사람의 말이다.
 */
export function builderRequestFrame(facts: BuilderRequestFacts, text: string): string {
  let head = `[Centralu] The person wrote this in the app "${frameField(facts.app.name)}" (app-${frameField(facts.app.appId)}) that you build`
  if (facts.screen) head += `, looking at its screen ${frameField(facts.screen.resourceUri)} (tool "${frameField(facts.screen.tool)}")`
  head += '.'
  if (facts.stopped) head += ` The app has stopped (${facts.stopped.status})${because(facts.stopped.reason)}.`
  const run = facts.latestRun
  if (run) head += ` Its latest run, ${frameField(run.tool)} from ${CALLER[run.callerKind]}, ${ENDED[run.status]}${because(run.error)}.`
  return text ? `${head}\n${text}` : head
}

/**
 * 까닭 한 줄 — 비어 있지 않은 첫 줄만. 오류는 대개 첫 줄이 까닭이고 나머지가 스택이다. 스택은 머리말이 아니라 오류
 * 묶음(C-6)이 나른다. 첫 줄이 비어 있는 오류("\nError: …")도 있어서 빈 줄은 건너뛴다. 아무것도 없으면 적지 않는다.
 */
function because(reason: string | null): string {
  const line = (reason ?? '')
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map((l) => l.trim())
    .find(Boolean)
  const flat = line ? frameField(line) : ''
  return flat ? `: ${flat}` : ''
}
