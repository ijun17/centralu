import { describe, expect, it } from 'vitest'
import { appendPath, hasDragFiles, hasDragPath, PATH_MIME } from './dragPath.js'

/**
 * 끌어다 놓기와 `@` 자동완성은 결과가 같아야 한다 —
 * 넣는 방법이 둘인데 문장이 다르면 도구가 받는 것도 달라진다.
 */
describe('appendPath', () => {
  it('빈 입력창에는 그대로 붙는다', () => {
    expect(appendPath('', 'src/a.ts')).toBe('@src/a.ts ')
  })

  it('쓰던 문장 뒤에는 띄어쓰기를 넣는다 — 앞말과 붙으면 경로가 아니게 된다', () => {
    expect(appendPath('이거 봐줘', 'src/a.ts')).toBe('이거 봐줘 @src/a.ts ')
  })

  it('이미 공백으로 끝나면 더 넣지 않는다', () => {
    expect(appendPath('이거 봐줘 ', 'src/a.ts')).toBe('이거 봐줘 @src/a.ts ')
    expect(appendPath('줄바꿈\n', 'src/a.ts')).toBe('줄바꿈\n@src/a.ts ')
  })

  it('여러 번 끌어다 놓으면 이어 붙는다', () => {
    const one = appendPath('', 'a.ts')
    expect(appendPath(one, 'b.ts')).toBe('@a.ts @b.ts ')
  })

  it('뒤에 공백을 남긴다 — 놓자마자 이어서 칠 수 있어야 한다', () => {
    expect(appendPath('', 'a.ts').endsWith(' ')).toBe(true)
  })
})

/**
 * 끌고 오는 것이 무엇인지 **내용을 열어보기 전에** 가른다 (#19).
 *
 * `dragover` 동안 `getData()`는 빈 문자열을 준다 — 브라우저가 드롭 전까지 내용을 가리기
 * 때문이다. 그래서 "이 자리가 이걸 받을 수 있는가"와 "받으면 옮기는 건가 복사인가"는
 * `types`만 보고 답해야 한다. 이걸 `getData`로 하면 커서가 늘 '못 놓는다'고 말하는
 * 트리가 되고, 그건 오류 없이 아무 일도 안 일어나는 모양으로만 드러난다.
 */
describe('무엇을 끌고 있는가', () => {
  const dt = (types: string[]) => ({ types }) as unknown as DataTransfer

  it('트리에서 끌어온 것은 우리 MIME으로 알아본다', () => {
    expect(hasDragPath(dt([PATH_MIME, 'text/plain']))).toBe(true)
    expect(hasDragFiles(dt([PATH_MIME, 'text/plain']))).toBe(false)
  })

  it('OS에서 끌어온 파일은 Files로 알아본다', () => {
    expect(hasDragFiles(dt(['Files']))).toBe(true)
    expect(hasDragPath(dt(['Files']))).toBe(false)
  })

  it('둘 다 아니면 받지 않는다 (선택한 글자를 끌어온 경우 등)', () => {
    expect(hasDragPath(dt(['text/plain']))).toBe(false)
    expect(hasDragFiles(dt(['text/plain']))).toBe(false)
  })
})
