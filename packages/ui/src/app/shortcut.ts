import { useCallback } from 'react'
import type { ShortcutKeys } from '@cc/platform/ports'
import { useCapability } from './PlatformProvider.jsx'

/**
 * 단축키를 **뜻으로** 적고, 자판이 이름을 붙이게 한다 (이슈 #32).
 *
 * `⌘`가 화면 곳곳에 그대로 박혀 있었다. 리눅스·윈도우에는 없는 키다 — 조합 자체는
 * 진작부터 `metaKey || ctrlKey`를 둘 다 받아서 **동작은 멀쩡했고 라벨만 거짓말**을 했다.
 * 글리프를 호출 지점마다 쓰면 그 거짓말이 61곳에 한꺼번에 생긴다.
 *
 * 그래서 부르는 쪽은 'mod'·'alt'라는 **뜻**만 쓴다. 그게 `⌘`인지 `Ctrl`인지는 자판을
 * 아는 쪽(@cc/platform)이 답한다 — ui는 자기가 어느 OS에 있는지 끝내 모른다.
 *
 * `⇧`는 토큰이 아니다. 그 자판들에도 똑같이 찍혀 있어서 옮길 말이 없고, 앞의 키에 붙여
 * 쓴다(`'⇧A'`) — `Ctrl+⇧+A`보다 `Ctrl+⇧A`가 읽힌다.
 */
const TOKENS = { mod: 'mod', alt: 'alt' } as const

/**
 * 한 덩어리 문자열로 쓴다: `('mod', 'I')` → `⌘I` 또는 `Ctrl+I`.
 *
 * 칸을 나눠 그리는 자리(`<Kbd mod />`)와 달리 title 속성·설정 표처럼 **문자열이어야만
 * 하는 자리**가 있어서 둘 다 필요하다. 붙여 쓸지 `+`로 이을지는 자판이 정한다.
 */
export function shortcut(keys: ShortcutKeys, ...parts: string[]): string {
  return parts
    .map((p) => (p === TOKENS.mod ? keys.mod : p === TOKENS.alt ? keys.alt : p))
    .join(keys.join)
}

/** 같은 것을, 지금 이 앱이 도는 자판에 묶어서 준다 */
export function useShortcut(): (...parts: string[]) => string {
  const keys = useCapability('shortcutKeys')
  // capabilities는 플랫폼 생성 시 한 번 만들어지므로 이 함수도 그동안 같은 것으로 남는다 —
  // 팔레트처럼 useMemo 의존성에 들어가는 자리가 있어서 정체성이 흔들리면 안 된다.
  return useCallback((...parts: string[]) => shortcut(keys, ...parts), [keys])
}
