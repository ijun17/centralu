import { describe, expect, it } from 'vitest'
import { letterOf } from './keys.js'

/** 실제 KeyboardEvent에서 이 함수가 보는 두 필드만 */
const ev = (key: string, code: string) => ({ key, code }) as Pick<KeyboardEvent, 'key' | 'code'>

/**
 * 글자 단축키를 자판이 만든 문자로만 읽던 것의 교정 (설정 화면의 `⌥a`가 맥에서 무반응).
 *
 * 아래 값들은 상상이 아니라 **설치된 자판 배열에 직접 물어본 것**이다
 * (Carbon UCKeyTranslate, 2026-08-24):
 *
 *   ABC / U.S.     A = a    ⌥A = å
 *   2-Set Korean   A = ㅁ   ⌥A = a
 */
describe('letterOf', () => {
  it('라틴 글자로 왔으면 그대로 믿는다', () => {
    expect(letterOf(ev('a', 'KeyA'))).toBe('a')
    expect(letterOf(ev('Y', 'KeyY'))).toBe('y')
  })

  it('⌥A는 å로 온다 — 설정이 광고하던 그 키가 여기서 죽어 있었다', () => {
    expect(letterOf(ev('å', 'KeyA'))).toBe('a')
  })

  it('한글 자판에서는 조합키 없이도 다른 글자로 온다', () => {
    expect(letterOf(ev('ㅁ', 'KeyA'))).toBe('a')
    expect(letterOf(ev('ㅓ', 'KeyJ'))).toBe('j')
    expect(letterOf(ev('ㅇ', 'KeyD'))).toBe('d')
  })

  /** IME가 키를 삼키는 중이면 브라우저는 이 이름을 준다 — 자리는 그대로다 */
  it('Process도 자리로 읽는다', () => {
    expect(letterOf(ev('Process', 'KeyN'))).toBe('n')
  })

  /**
   * **자리로 통일하지 않는 이유.** Dvorak에서 y는 QWERTY의 KeyF 자리에 있다. 자리만 보면
   * 사용자가 f를 눌렀을 때 y로 읽고, y는 이 앱에서 승인이다 — 가장 잘못 눌리면 안 되는 것을
   * 자판 배열 때문에 잘못 읽을 수는 없다. 라틴 글자로 온 것은 사용자가 실제로 낸 글자다.
   */
  it('Dvorak: 글자가 라틴이면 자리를 묻지 않는다 — f는 f다', () => {
    expect(letterOf(ev('f', 'KeyY'))).toBe('f')
    expect(letterOf(ev('y', 'KeyF'))).toBe('y')
  })

  it('글자가 아닌 것은 글자인 척하지 않는다', () => {
    expect(letterOf(ev('Enter', 'Enter'))).toBeNull()
    expect(letterOf(ev('ArrowDown', 'ArrowDown'))).toBeNull()
    expect(letterOf(ev('1', 'Digit1'))).toBeNull()
    expect(letterOf(ev('!', 'Digit1'))).toBeNull()
    expect(letterOf(ev('Escape', 'Escape'))).toBeNull()
  })
})
