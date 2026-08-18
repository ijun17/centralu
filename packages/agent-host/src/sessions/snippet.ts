/**
 * 찾은 낱말 **둘레를 잘라낸다.**
 *
 * 전에는 SQLite의 `snippet(..., 12)`에 맡겼는데, 그 12는 글자 수가 아니라 토큰 수고
 * 토크나이저가 trigram이라 실질 15자쯤에서 끊겼다. 오케스트레이터에게 도착한 것은
 * `"은하수 색이 이미 정책 목…"` 같은 토막이라 **찾던 대목인지 가릴 수가 없었다.**
 *
 * 여기서 자르면 두 가지가 생긴다: 앞뒤 문맥을 원하는 만큼 줄 수 있고,
 * 자른 자리를 말줄임표로 정직하게 표시할 수 있다.
 */
export function windowAround(body: string, query: string, radius: number): string {
  const text = body.replace(/\s+/g, ' ').trim()
  if (text.length <= radius * 2) return text

  const at = text.toLowerCase().indexOf(query.trim().toLowerCase())
  // 못 찾으면(FTS가 다른 형태로 맞춘 경우) 앞머리를 준다 — 빈손보다 낫다
  if (at < 0) return text.slice(0, radius * 2) + '…'

  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/**
 * 같은 응답의 조각들을 하나로 본다.
 *
 * 저장소의 한 행은 메시지가 아니라 **스트리밍 델타 하나**라, 한 번의 응답이 수백 행이다.
 * 그래서 한 응답 안에서 낱말이 여러 번 나오면 검색 결과가 같은 이야기로 도배된다 —
 * 도그푸딩에서 limit 8로 부른 결과의 실질이 3건이었다.
 *
 * seq가 가까운 것들은 같은 이야기로 묶고 **가장 앞의 것만** 남긴다.
 */
export function dedupeNearbyHits<T extends { sessionId: string; seq: number }>(hits: T[], gap = 40): T[] {
  const kept: T[] = []
  const bySession = new Map<string, number[]>()
  for (const h of hits) {
    const seen = bySession.get(h.sessionId) ?? []
    if (seen.some((s) => Math.abs(s - h.seq) <= gap)) continue
    seen.push(h.seq)
    bySession.set(h.sessionId, seen)
    kept.push(h)
  }
  return kept
}
