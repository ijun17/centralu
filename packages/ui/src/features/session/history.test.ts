import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../store/store.js'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'

const user = (seq: number, text: string): ChatItem => ({ kind: 'user', seq, text })
const bot = (seq: number, text: string): ChatItem => ({ kind: 'assistant', seq, text })

describe('보낸 말 모으기', () => {
  it('내 말만, 오래된 것부터', () => {
    expect(sentMessages([user(1, '하나'), bot(2, '답'), user(3, '둘')])).toEqual(['하나', '둘'])
  })

  it('연달아 같은 말은 한 번만 — 화살표를 두 번 눌러야 넘어가면 안 눌린 것처럼 보인다', () => {
    expect(sentMessages([user(1, '다시'), user(2, '다시'), user(3, '그만')])).toEqual(['다시', '그만'])
  })

  it('사이에 다른 말이 끼면 같은 말도 다시 센다 — 그때는 정말 두 번 보낸 것이다', () => {
    expect(sentMessages([user(1, 'a'), user(2, 'b'), user(3, 'a')])).toEqual(['a', 'b', 'a'])
  })

  it('도구·승인 기록은 내가 한 말이 아니다', () => {
    const chat: ChatItem[] = [
      { kind: 'tool', seq: 1, tool: 'Bash', title: 'ls', readOnly: true },
      { kind: 'mark', seq: 2, text: '압축됨' },
      user(3, '진짜 내 말'),
    ]
    expect(sentMessages(chat)).toEqual(['진짜 내 말'])
  })
})

describe('커서가 어느 줄에 있나', () => {
  it('한 줄짜리는 첫 줄이면서 마지막 줄이다 — 그래야 위아래가 다 기록으로 간다', () => {
    expect(onFirstLine('한 줄', 2)).toBe(true)
    expect(onLastLine('한 줄', 2)).toBe(true)
  })

  it('여러 줄에서는 위쪽 줄에서만 위로 간다', () => {
    const text = '첫 줄\n둘째 줄'
    expect(onFirstLine(text, 1)).toBe(true)
    expect(onFirstLine(text, 7)).toBe(false)
    expect(onLastLine(text, 1)).toBe(false)
    expect(onLastLine(text, 7)).toBe(true)
  })

  it('개행 바로 앞뒤의 경계', () => {
    const text = 'a\nb'
    // 개행 앞 = 아직 첫 줄
    expect(onFirstLine(text, 1)).toBe(true)
    expect(onLastLine(text, 1)).toBe(false)
    // 개행 뒤 = 이미 마지막 줄
    expect(onFirstLine(text, 2)).toBe(false)
    expect(onLastLine(text, 2)).toBe(true)
  })

  it('빈 입력창은 양쪽 다 참이다', () => {
    expect(onFirstLine('', 0)).toBe(true)
    expect(onLastLine('', 0)).toBe(true)
  })
})

describe('화살표 한 번', () => {
  const history = ['가장 오래된', '가운데', '가장 최근']

  it('처음 위로 누르면 가장 최근에 보낸 말', () => {
    expect(stepHistory({ history, at: null, dir: -1 })).toEqual({ kind: 'recall', at: 2, text: '가장 최근' })
  })

  it('계속 위로 누르면 거슬러 올라간다', () => {
    expect(stepHistory({ history, at: 2, dir: -1 })).toEqual({ kind: 'recall', at: 1, text: '가운데' })
  })

  /* 커서를 움직이게 두면 "기록이 끝났다"가 "화살표가 안 먹는다"로 읽힌다 */
  it('가장 오래된 것에서 더 위로는 그 자리에 머문다', () => {
    expect(stepHistory({ history, at: 0, dir: -1 })).toEqual({ kind: 'recall', at: 0, text: '가장 오래된' })
  })

  it('아래로 내려오면 더 최근으로', () => {
    expect(stepHistory({ history, at: 0, dir: 1 })).toEqual({ kind: 'recall', at: 1, text: '가운데' })
  })

  /* 스쳐 지나간 키 하나에 쓰던 글을 잃는 것이 이 앱이 계속 고쳐 온 종류의 손실이다 */
  it('가장 최근에서 한 번 더 내려오면 쓰다 만 글로 돌아간다', () => {
    expect(stepHistory({ history, at: 2, dir: 1 })).toEqual({ kind: 'draft' })
  })

  it('기록에 들어가지 않은 채 아래 화살표는 그냥 커서다', () => {
    expect(stepHistory({ history, at: null, dir: 1 })).toEqual({ kind: 'none' })
  })

  it('보낸 말이 없으면 화살표는 화살표다', () => {
    expect(stepHistory({ history: [], at: null, dir: -1 })).toEqual({ kind: 'none' })
  })
})
