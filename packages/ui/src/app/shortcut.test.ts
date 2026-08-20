import { describe, expect, it } from 'vitest'
import type { ShortcutKeys } from '@cc/platform/ports'
import { shortcut } from './shortcut.js'

/** 맥 자판 — 기호라서 붙여 쓴다 */
const MAC: ShortcutKeys = { mod: '⌘', alt: '⌥', join: '' }
/** 그 밖 — 이름이라서 이어 쓴다 */
const PC: ShortcutKeys = { mod: 'Ctrl', alt: 'Alt', join: '+' }

describe('단축키 표기 (#32)', () => {
  it('맥에서는 지금까지 화면에 있던 그대로다', () => {
    // 이 문자열들이 바뀌면 E2E와 설정 표가 같이 무너진다 — 스윕은 표기를 옮긴 게 아니라
    // **어디서 정하는지**를 옮긴 것이다
    expect(shortcut(MAC, 'mod', 'I')).toBe('⌘I')
    expect(shortcut(MAC, 'mod', '⇧A')).toBe('⌘⇧A')
    expect(shortcut(MAC, 'mod', '⇧1~4')).toBe('⌘⇧1~4')
    expect(shortcut(MAC, 'alt', 'a')).toBe('⌥a')
  })

  it('command 키가 없는 자판에서는 Ctrl이라고 말한다', () => {
    expect(shortcut(PC, 'mod', 'I')).toBe('Ctrl+I')
    expect(shortcut(PC, 'mod', 'K')).toBe('Ctrl+K')
    expect(shortcut(PC, 'alt', 'a')).toBe('Alt+a')
  })

  /*
   * 구분자가 자판에 딸려 오는 이유.
   *
   * 맥은 `⌘⇧A`처럼 붙여 쓰고 그게 읽히는 건 조각들이 기호이기 때문이다.
   * 같은 규칙을 이름에 적용하면 `CtrlShiftA`가 된다 — 조합이 아니라 낱말로 보인다.
   */
  it('이름이 붙어 버리지 않는다', () => {
    expect(shortcut(PC, 'mod', '⇧A')).toBe('Ctrl+⇧A')
    expect(shortcut(PC, 'mod', '⇧A')).not.toContain('Ctrl⇧')
  })

  it('토큰이 아닌 조각은 자판이 뭐든 그대로 간다', () => {
    // 'mod'·'alt' 둘만 번역한다. 나머지는 키 이름 그 자체다
    expect(shortcut(MAC, 'esc')).toBe('esc')
    expect(shortcut(PC, 'mod', '1~9')).toBe('Ctrl+1~9')
  })

  it('조각 하나면 이을 것도 없다', () => {
    // ApprovalCard의 "Hold ⌥ and click…"처럼 조합키 하나만 부르는 자리가 있다
    expect(shortcut(MAC, 'alt')).toBe('⌥')
    expect(shortcut(PC, 'alt')).toBe('Alt')
  })
})
