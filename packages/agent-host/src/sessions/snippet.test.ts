import { describe, expect, it } from 'vitest'
import { dedupeNearbyHits, windowAround } from './snippet.js'

/**
 * 도그푸딩에서 recall이 못 쓰게 된 두 이유를 그대로 시험한다:
 * 조각이 너무 짧아 판단이 안 됐고, 같은 말이 여러 번 나와 limit이 무의미했다.
 */
describe('찾은 자리 둘레 잘라내기', () => {
  const body = `${'앞'.repeat(400)}은하수 그라데이션${'뒤'.repeat(400)}`

  it('낱말 앞뒤로 문맥을 준다 — 15자 토막으로는 무엇인지 가릴 수 없다', () => {
    const s = windowAround(body, '은하수', 160)
    expect(s).toContain('은하수 그라데이션')
    // 앞뒤가 실제로 딸려온다
    expect(s.length).toBeGreaterThan(300)
    expect(s).toMatch(/^…앞/)
    expect(s).toMatch(/뒤…$/)
  })

  it('짧은 본문은 통째로 준다 (자를 것이 없으면 자르지 않는다)', () => {
    expect(windowAround('짧은 말', '짧은', 160)).toBe('짧은 말')
  })

  it('낱말을 못 찾아도 빈손으로 돌려보내지 않는다', () => {
    // FTS가 다른 형태(조사 붙은 꼴 등)로 맞춘 경우
    const s = windowAround(body, '없는낱말', 50)
    expect(s.length).toBeGreaterThan(0)
  })

  it('줄바꿈은 한 칸으로 — 한 줄 결과에 여러 줄이 끼면 목록이 깨진다', () => {
    expect(windowAround('가\n\n나   다', '가', 100)).toBe('가 나 다')
  })
})

describe('가까운 결과 걷어내기', () => {
  /*
   * 저장소의 한 행은 스트리밍 델타 하나라 한 응답이 수백 행이다.
   * 그래서 한 응답 안에서 낱말이 여러 번 나오면 같은 이야기가 여러 건으로 잡힌다
   * (도그푸딩: limit 8인데 같은 것이 5번, 실질 3건).
   */
  it('같은 세션에서 seq가 가까우면 한 건으로 본다', () => {
    const hits = [
      { sessionId: 'a', seq: 100 },
      { sessionId: 'a', seq: 103 },
      { sessionId: 'a', seq: 118 },
      { sessionId: 'a', seq: 400 },
    ]
    expect(dedupeNearbyHits(hits)).toEqual([
      { sessionId: 'a', seq: 100 },
      { sessionId: 'a', seq: 400 },
    ])
  })

  it('세션이 다르면 seq가 같아도 남긴다 — 서로 다른 이야기다', () => {
    const hits = [
      { sessionId: 'a', seq: 100 },
      { sessionId: 'b', seq: 100 },
    ]
    expect(dedupeNearbyHits(hits)).toHaveLength(2)
  })

  it('가장 앞의 것을 남긴다 (검색 순위가 높은 쪽)', () => {
    const hits = [
      { sessionId: 'a', seq: 200 },
      { sessionId: 'a', seq: 201 },
    ]
    expect(dedupeNearbyHits(hits)[0]!.seq).toBe(200)
  })
})
