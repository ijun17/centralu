import { describe, expect, it } from 'vitest'
import type { ApprovalDetail } from '@cc/protocol'
import {
  DEFAULT_BANNER_POLICY,
  bannerDecision,
  findMatchingRule,
  matchesRule,
  previewMatches,
  suggestMatcher,
} from './approval.js'

const cmd = (command: string): ApprovalDetail => ({ kind: 'command', command, cwd: '/p' })

describe('배너 제자리 승인 판정 (FR-3 — 강제 아닌 정보 부족 표시)', () => {
  it('짧은 명령은 배너에서 바로 승인', () => {
    expect(bannerDecision(cmd('npm run build'))).toEqual({ mode: 'inline' })
  })

  it('긴 명령은 배너에서 잘리므로 확인 필요', () => {
    const d = bannerDecision(cmd('x'.repeat(DEFAULT_BANNER_POLICY.maxCommandLength + 1)))
    expect(d).toEqual({ mode: 'needs_review', reason: 'too_long' })
  })

  it('파일 수정은 diff를 봐야 하므로 확인 필요', () => {
    const d = bannerDecision({ kind: 'file_edit', path: 'a.ts', diffPreview: '+1', multi: false })
    expect(d).toEqual({ mode: 'needs_review', reason: 'diff_required' })
  })

  it('다중 파일은 정책과 무관하게 확인 필요', () => {
    const d = bannerDecision(
      { kind: 'file_edit', path: 'a.ts', diffPreview: '+1', multi: true },
      { ...DEFAULT_BANNER_POLICY, allowInlineFileEdit: true },
    )
    expect(d).toEqual({ mode: 'needs_review', reason: 'multi_file' })
  })

  it('정책으로 파일 수정 제자리 승인을 켤 수 있다 (사용자 선택 존중)', () => {
    const d = bannerDecision(
      { kind: 'file_edit', path: 'a.ts', diffPreview: '+1', multi: false },
      { ...DEFAULT_BANNER_POLICY, allowInlineFileEdit: true },
    )
    expect(d).toEqual({ mode: 'inline' })
  })

  it('알 수 없는 종류는 항상 확인 필요', () => {
    expect(bannerDecision({ kind: 'other', raw: '{}' }).mode).toBe('needs_review')
  })
})

describe('항상 허용 규칙 매칭', () => {
  it('패턴 없으면 완전 일치만', () => {
    expect(matchesRule('npm test', 'npm test')).toBe(true)
    expect(matchesRule('npm test --watch', 'npm test')).toBe(false)
  })

  it('* 패턴을 지원한다', () => {
    expect(matchesRule('npm test --watch', 'npm test*')).toBe(true)
    expect(matchesRule('npm install', 'npm test*')).toBe(false)
  })

  it('정규식 메타문자는 이스케이프된다 (오적용 방지)', () => {
    expect(matchesRule('rm -rf /', 'rm -rf .')).toBe(false)
    expect(matchesRule('a.b', 'a.b')).toBe(true)
    expect(matchesRule('axb', 'a.b')).toBe(false)
  })

  it('세션 규칙은 다른 세션에 적용되지 않는다', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: 'npm*' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's1', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 's2', projectId: 'p1' })).toBeNull()
  })

  it('프로젝트 규칙은 그 프로젝트의 모든 세션에 적용된다', () => {
    const rules = [{ scope: 'project' as const, projectId: 'p1', matcher: 'npm*' }]
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p1' })).not.toBeNull()
    expect(findMatchingRule(cmd('npm test'), rules, { sessionId: 'sX', projectId: 'p2' })).toBeNull()
  })

  it('파일 수정에는 명령 규칙이 적용되지 않는다', () => {
    const rules = [{ scope: 'session' as const, sessionId: 's1', matcher: '*' }]
    const detail: ApprovalDetail = { kind: 'file_edit', path: 'a.ts', diffPreview: '', multi: false }
    expect(findMatchingRule(detail, rules, { sessionId: 's1', projectId: 'p1' })).toBeNull()
  })
})

describe('규칙 미리보기 (표현력 제한 대신 결과 가시화)', () => {
  it('히스토리에서 매치되는 명령을 보여준다', () => {
    const history = ['npm test', 'npm test:watch', 'npm install', 'npm test']
    expect(previewMatches('npm test*', history)).toEqual(['npm test', 'npm test:watch'])
  })

  it('명령에서 패턴을 제안한다', () => {
    expect(suggestMatcher('npm test --watch')).toBe('npm test*')
    expect(suggestMatcher('ls')).toBe('ls')
  })
})
