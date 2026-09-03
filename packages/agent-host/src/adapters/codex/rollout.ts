import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 죽은 codex의 마지막 컴팩트 요약 (#78) — **롤아웃 파일에서, 바이너리 없이**.
 *
 * 서비스가 중단된 에이전트에게는 요약을 부탁할 수 없지만, codex의 컴팩트 요약은
 * 롤아웃 파일에 평문으로 남는다 (실측 2026-09-04: `compacted` 아이템의
 * replacement_history 첫 user 메시지가 요약 원문이다). 로컬 파일이라 API가 죽어도,
 * 심지어 codex 바이너리가 깨져도 읽힌다 — 파일 위치도 **파일명**으로 찾는다
 * (`rollout-…-<threadId>.jsonl`): getConversationSummary RPC는 이름과 달리
 * 메타데이터만 주는 데다 살아 있는 바이너리를 요구한다.
 *
 * 롤아웃 포맷은 비공식이다. 그래서 이 의존은 **재해 경로에만** 산다 — 컴팩트마다
 * 도는 상시 경로로 승격하지 않는다(#78 결정). 어떤 실패도 null로 눕는다:
 * 요약이 없으면 기록 빌더가 원문 계층 압축으로 물러날 뿐, 인수인계는 계속된다.
 */

/** 요약이라 부를 최소 길이 — 몇 글자짜리 조각을 "요약"으로 승격시키지 않는다 */
const MIN_SUMMARY_CHARS = 200

export async function findRolloutPath(
  threadId: string,
  sessionsDir = join(homedir(), '.codex', 'sessions'),
): Promise<string | null> {
  try {
    const suffix = `-${threadId}.jsonl`
    const names = await readdir(sessionsDir, { recursive: true })
    // 같은 스레드의 롤아웃은 하나다 — 여럿이면(있을 수 없지만) 이름 정렬상 마지막(최신 타임스탬프)
    const hits = names.filter((n) => String(n).endsWith(suffix)).sort()
    const hit = hits[hits.length - 1]
    return hit ? join(sessionsDir, String(hit)) : null
  } catch {
    return null
  }
}

/** compacted 아이템 하나에서 요약 텍스트를 꺼낸다 — message가 비면 replacement_history의 첫 user 메시지 */
function summaryOf(payload: unknown): string | null {
  const p = payload as {
    message?: unknown
    replacement_history?: { type?: string; role?: string; content?: { type?: string; text?: string }[] }[]
  }
  if (typeof p.message === 'string' && p.message.trim().length >= MIN_SUMMARY_CHARS) return p.message
  for (const item of p.replacement_history ?? []) {
    if (item.type !== 'message' || item.role !== 'user') continue
    const text = (item.content ?? [])
      .filter((c) => c.type === 'input_text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    // 첫 user 메시지가 요약이다 (실측). 너무 짧으면 요약이 아니라 보존된 일반 메시지다
    return text.trim().length >= MIN_SUMMARY_CHARS ? text : null
  }
  return null
}

/**
 * 롤아웃을 순차로 흘려 읽으며 **마지막** compacted의 요약을 남긴다.
 * 550MB급 파일도 스트림이라 메모리는 한 줄 몫이다 — 파싱은 'compacted'가
 * 들어 있는 줄만 한다 (대부분의 줄은 그 문자열 검사 한 번으로 지나간다).
 */
export async function lastCompactSummary(
  threadId: string,
  sessionsDir?: string,
): Promise<string | null> {
  const path = await findRolloutPath(threadId, sessionsDir)
  if (!path) return null
  try {
    let last: string | null = null
    const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"compacted"')) continue
      try {
        const j = JSON.parse(line) as { type?: string; payload?: unknown }
        if (j.type !== 'compacted') continue
        const s = summaryOf(j.payload)
        if (s) last = s
      } catch {
        // 깨진 줄은 건너뛴다 — 도구가 쓰다 만 마지막 줄일 수 있다
      }
    }
    return last
  } catch {
    return null
  }
}
