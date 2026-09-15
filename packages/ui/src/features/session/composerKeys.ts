/**
 * 입력창에서 Enter를 어떻게 읽을 것인가 — 판단만 떼어낸다.
 *
 * DOM도 store도 모른다. 조합(Shift·⌘/Ctrl)과 IME 상태와 설정이 만나는 자리라 경우의
 * 수가 여덟 가지인데, 그중 하나만 틀려도 결과가 "쓰던 글이 반쯤 나갔다"다 —
 * 브라우저를 띄우지 않고 여덟 가지를 다 짚을 수 있어야 한다 (caret.ts와 같은 이유).
 */

/** 판단에 필요한 것만. KeyboardEvent 전체가 아니라 이 다섯 개다 */
export type ComposerKey = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /**
   * IME가 글자를 만드는 중인가.
   *
   * **부르는 쪽이 판정해서 넘긴다.** 이 값을 여기서 계산하지 않는 이유는 그 판정이
   * 네이티브 이벤트(`isComposing`)를 읽어야만 나오는 것이라서다 — 그 한 줄은
   * 입력창에 남고, 여기는 "조합 중이면 아무것도 하지 않는다"만 안다.
   */
  composing: boolean
}

/**
 * 이 키가 **보내기**인가.
 *
 * `sendWithModifierEnter`가 꺼져 있으면 예전 그대로다: 맨 Enter는 보내고 Shift+Enter는
 * 줄을 바꾼다. 켜면 둘이 뒤집히는 것이 아니라 **Enter가 전부 줄바꿈이 되고** 보내기가
 * ⌘/Ctrl+Enter로 옮겨 간다.
 *
 * 조합키는 `metaKey || ctrlKey` 둘 다 받는다. 맥의 ⌘와 나머지 자판의 Ctrl을 한 판정으로
 * 덮으려는 것이고, 그래서 이 파일은 자기가 어느 OS에 있는지 물어볼 일이 없다
 * (화면에 찍는 이름만 포트가 답한다 — `useShortcut`).
 *
 * 조합 중(IME)에는 무엇이 눌렸든 보내지 않는다. 설정을 켠 사람도 마찬가지다: ⌘+Enter가
 * 한글을 만드는 중에 먹히면, 켜서 얻으려던 것(반쯤 쓴 글이 안 나가는 것)을 그대로 잃는다.
 */
export function isComposerSendKey(e: ComposerKey, sendWithModifierEnter: boolean): boolean {
  if (e.composing || e.key !== 'Enter') return false
  if (sendWithModifierEnter) return e.metaKey || e.ctrlKey
  return !e.shiftKey
}
