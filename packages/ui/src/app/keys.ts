/**
 * 키 하나가 가리키는 **라틴 글자**. 없으면 null.
 *
 * 글자 단축키(y·n·a, j·k·d)는 `e.key`만 보고 있었다. 그 값은 자판이 실제로 만들어낸
 * 문자라, 라틴 자판을 쓰지 않거나 조합키가 문자를 바꾸는 순간 비교가 통째로 빗나간다.
 * 설치된 배열에 직접 물어본 값이다(UCKeyTranslate):
 *
 *   ABC / U.S.     A = a    ⌥A = å
 *   2-Set Korean   A = ㅁ   ⌥A = a
 *
 * 그래서 설정 화면이 광고하는 `⌥a`("항상 허용 — 프로젝트 범위")는 **맥에서 아무 일도
 * 하지 않았다.** `'å' === 'a'`가 거짓이기 때문이다. 리눅스·윈도우에서는 Alt가 문자를
 * 바꾸지 않아 멀쩡히 됐다 — 이 앱이 매일 도는 쪽에서만 죽어 있었던 셈이다.
 * 한글 입력 중에는 같은 이유로 y·n·a·j·k·d가 전부 다른 글자로 도착한다.
 *
 * **규칙: 문자가 라틴 글자가 아닐 때만 누른 자리를 묻는다.**
 *
 * `e.code`(물리적 자리)로 통일하지 않는 이유는 Dvorak이다. Dvorak에서 'y'는 QWERTY의
 * `KeyF` 자리에 있으므로, 자리만 보면 사용자가 'f'를 눌렀을 때 'y'로 읽는다 — 그리고
 * 'y'는 이 앱에서 **승인**이다. 잘못 눌리면 안 되는 것 1순위를 자판 배열 하나 때문에
 * 잘못 읽을 수는 없다. 반대로 문자가 라틴 글자로 왔다면 그건 사용자가 실제로 낸 글자이니
 * 그대로 믿으면 된다. 라틴 글자가 아닐 때만 — 즉 배열이나 조합키가 문자를 바꿔치기해서
 * 의도를 알 길이 그것밖에 안 남았을 때만 — 자리를 본다.
 */
export function letterOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  const key = e.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key
  // `KeyA`…`KeyZ`만 본다. `Digit1`이나 `Enter`는 글자가 아니고, 글자인 척해서도 안 된다
  const spot = /^Key([A-Z])$/.exec(e.code)
  return spot ? spot[1]!.toLowerCase() : null
}

/**
 * 글을 받는 칸인가 (#181) — 그 칸 안의 화살표·Enter는 칸의 것이다. 체크박스·단추 같은 input은 글을 받지 않는다.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

/**
 * 확인 창(종료 확인)에서 키 하나가 무엇인가 (#181) — 순수 함수라 브라우저 없이 시험한다.
 *
 *  - 조합 중인 키는 아무것도 아니다. 한글을 쓰다가 창이 떴을 때 조합을 끝내려고 누른 Enter가 앱을 껐고, 조합을
 *    취소하려는 Esc가 창을 닫았다.
 *  - 단추 위의 Enter는 그 단추의 것이다 — Tab으로 Cancel에 가서 누른 Enter가 종료가 되면 안 된다(단추가 스스로 눌린다).
 *  - 그 밖의 Enter는 확인, Esc는 취소다.
 */
export function confirmKeyAction(e: { key: string; isComposing: boolean; onButton: boolean }): 'confirm' | 'cancel' | null {
  if (e.isComposing || e.key === 'Process') return null
  if (e.key === 'Escape') return 'cancel'
  if (e.key === 'Enter' && !e.onButton) return 'confirm'
  return null
}

