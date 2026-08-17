import { describe, expect, it } from 'vitest'
import { appendPath } from './dragPath.js'

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
