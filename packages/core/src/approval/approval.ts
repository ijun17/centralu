import type { ApprovalDetail, ApprovalScope } from '@cc/protocol'

/**
 * 승인 정책 (FR-3). "막지 말고 보이게 하라" — 제자리 승인을 금지하는 게 아니라,
 * 정보가 부족한 요청만 "확인 필요"로 표시한다.
 */

export type BannerPolicy = {
  /** 도구 종류별 배너 제자리 승인 허용 여부 (설정에서 조정 가능) */
  allowInlineCommand: boolean
  allowInlineFileEdit: boolean
  /** 이보다 긴 명령은 배너에서 잘리므로 점프 유도 */
  maxCommandLength: number
}

export const DEFAULT_BANNER_POLICY: BannerPolicy = {
  allowInlineCommand: true,
  allowInlineFileEdit: false, // diff를 봐야 판단 가능
  maxCommandLength: 120,
}

export type BannerDecision =
  | { mode: 'inline' }
  | { mode: 'needs_review'; reason: 'diff_required' | 'too_long' | 'multi_file' | 'unknown_kind' }

export function bannerDecision(detail: ApprovalDetail, policy = DEFAULT_BANNER_POLICY): BannerDecision {
  switch (detail.kind) {
    case 'command':
      if (!policy.allowInlineCommand) return { mode: 'needs_review', reason: 'unknown_kind' }
      if (detail.command.length > policy.maxCommandLength) return { mode: 'needs_review', reason: 'too_long' }
      return { mode: 'inline' }
    case 'file_edit':
      if (detail.multi) return { mode: 'needs_review', reason: 'multi_file' }
      if (!policy.allowInlineFileEdit) return { mode: 'needs_review', reason: 'diff_required' }
      return { mode: 'inline' }
    case 'other':
      return { mode: 'needs_review', reason: 'unknown_kind' }
  }
}

/*
 * 도구 카드의 접힘 정책은 여기 없다.
 *
 * "조회성은 접고 변경은 펼친다"는 규칙이 있었는데, 도구를 몇 번만 써도 대화가
 * 출력으로 뒤덮여 답을 못 읽었다 (도그푸딩). 지금은 **전부 접는다** —
 * 입력이 무엇이든 답이 같으므로 정책이랄 것이 없어졌다.
 * 규칙이 하나로 줄면 그 규칙은 코드가 아니라 기본값으로 표현하는 게 맞다.
 */

/**
 * "항상 허용" 규칙 (FR-3). 패턴을 허용하되 등록 시 매치 미리보기를 보여준다 —
 * 표현력을 제한하는 대신 결과를 가시화한다.
 */
export type ApprovalRule = {
  scope: ApprovalScope
  projectId?: string
  sessionId?: string
  /** glob 유사 패턴: * 만 지원 (0자 이상) */
  matcher: string
}

export function matchesRule(command: string, matcher: string): boolean {
  if (!matcher.includes('*')) return command === matcher
  const escaped = matcher.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(command)
}

export function findMatchingRule(
  detail: ApprovalDetail,
  rules: readonly ApprovalRule[],
  ctx: { sessionId: string; projectId: string },
): ApprovalRule | null {
  if (detail.kind !== 'command') return null
  return (
    rules.find((r) => {
      if (r.scope === 'session' && r.sessionId !== ctx.sessionId) return false
      if (r.scope === 'project' && r.projectId !== ctx.projectId) return false
      return matchesRule(detail.command, r.matcher)
    }) ?? null
  )
}

/** 규칙 등록 시 "이 규칙에 매치되는 명령" 미리보기 (FR-3) */
export function previewMatches(matcher: string, history: readonly string[]): string[] {
  return [...new Set(history.filter((c) => matchesRule(c, matcher)))]
}

/**
 * 승인 카드의 "항상 허용" 기본 패턴 제안 — 승인한 명령 전체를 그대로.
 *
 * 앞 두 단어 + '*'로 넓히던 시절, `rm -rf node_modules` 승인이 `rm -rf*`를 제안해
 * `rm -rf /`까지 자동 승인될 뻔했다. 전체 명령 뒤에 '*'를 붙이는 것도 안전하지 않다 —
 * `cmd*`는 `cmd; rm -rf /` 같은 체이닝에 뚫린다. 그래서 기본 제안은 완전 일치이고,
 * 넓히는 건 사용자가 직접 고쳐서 미리보기(previewMatches)로 결과를 확인한 뒤 한다.
 */
export function suggestMatcher(command: string): string {
  return command.trim()
}
