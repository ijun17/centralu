import type { GitCommit } from '@cc/protocol'

/**
 * 커밋 귀속 (#50) — 훅 없이, 관찰로.
 *
 * 결정(2026-08-23): 저장소에는 아무것도 쓰지 않는다. 트레일러·훅·템플릿은 남의
 * 저장소를 더럽히고 워크플로우를 강제한다 — 이 앱이 거듭 거절해 온 바로 그것이다.
 * 대신 커밋이 **우리 눈앞에서** 일어난다는 사실을 쓴다: 에이전트는 git commit을
 * 도구 호출로 실행하고, 그 출력은 이미 우리 이벤트 스트림에 있다.
 */

/**
 * `git commit` 출력의 `[branch abc1234]` 줄에서 해시를 줍는다.
 * detached HEAD의 `[detached HEAD abc1234]`도 같은 모양이다.
 */
export function parseCommitSha(output: string): string | null {
  const m = /\[[^[\]\n]*[ (]([0-9a-f]{7,40})\]/.exec(output)
  return m?.[1] ?? null
}

/** 이 도구 호출이 커밋을 만들 수 있는 명령인가 — 파이프라인 속 `git commit`도 잡는다 */
export function looksLikeGitCommit(command: string): boolean {
  return /\bgit\b[^\n]*?\bcommit\b/.test(command)
}

/**
 * 커밋 목록에 세션 이름을 단다. 기록된 해시는 짧을 수 있으므로(잘린 출력에서 주운
 * 7자리) 접두사로 맞춘다 — git이 짧은 해시를 푸는 것과 같은 규칙이다.
 */
export function attachCommitSessions(
  commits: GitCommit[],
  records: { sha: string; sessionId: string }[],
  nameOf: (sessionId: string) => string | undefined,
): GitCommit[] {
  if (records.length === 0) return commits
  return commits.map((c) => {
    const rec = records.find((r) => c.sha.startsWith(r.sha) || r.sha.startsWith(c.sha))
    if (!rec) return c
    // 세션이 지워졌어도 "에이전트가 만들었다"는 사실은 남긴다
    return { ...c, sessionName: nameOf(rec.sessionId) ?? '(지워진 세션)' }
  })
}
