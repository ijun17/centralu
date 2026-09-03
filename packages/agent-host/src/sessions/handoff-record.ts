import type { StoredMessage } from '@cc/protocol'

/**
 * 죽은-에이전트 인수인계 기록 (#78) — **요약자 없는 인수인계**.
 *
 * 살아 있는 인수인계는 죽는 에이전트가 노트를 쓴다. 서비스가 중단되면 그 길이
 * 막히는데, 대화 원문은 우리 저장소에 컴팩션 없이 전부 남아 있다. 이 모듈은
 * 그 원문을 후임자의 첫 메시지로 물질화한다 — LLM 없이, 결정론적으로.
 *
 * **파일이 아니라 initialPrompt 직송이다** (설계 반전, 이슈 #78). 파일은 반쯤
 * 쓰임·엉뚱한 옛 파일·고아·실수 커밋이라는 실수 계급을 만든다. 직송은 원자적이다:
 * 세션 생성이 성공하면 내용도 함께 있고, 실패하면 아무것도 없다.
 * 전송 한계는 실측으로 확인했다(244KB 단일 메시지가 양쪽 CLI를 통과, 2026-09-04).
 *
 * **예산이 불변량이다.** 컨텍스트를 90% 채운 세션도 기록은 예산 안이다 — 브리핑이지
 * 클론이 아니다. 90%로 태어난 후임자는 태어나자마자 다시 인수인계가 필요하다.
 * 사다리(위에서부터 지키고 아래부터 버린다):
 *   1. 컴팩트 요약 원문 — 불가침 (병적으로 크면 그것만 예외적으로 자른다)
 *   2. 최근 항목들 원문 — 전임자가 "머리에 들고 있던" 부분
 *   3. 오래된 assistant → 앞 500자로 강등
 *   4. 그래도 넘치면 오래된 것부터 탈락
 * 탈락은 유실이 아니다: 원문은 DB에 그대로 있고, 그 사실을 기록 안에 적는다.
 *
 * 피벗(마지막 컴팩트 마커)의 두 갈래:
 *   - 요약이 **있으면**(codex 롤아웃) 피벗 이전은 요약이 대신한다 — 원문은 안 싣는다.
 *   - 요약이 **없으면**(claude·추출 실패) 피벗 이전도 싣되 assistant는 즉시 머리로
 *     강등한다 — 전임자의 컨텍스트에서도 이미 접혀 있던 부분이다.
 *
 * **툴 입출력은 한 줄 흔적만** (`[tool] Bash: pnpm test → ok`). 세 가지 이유:
 * 부피(컨텍스트를 채우는 주범), 재현 가능성(파일은 저장소에 있고 명령은 다시
 * 돌리면 된다 — 재현 불가능한 판단은 assistant 텍스트에 있다), 주입(제3자 텍스트를
 * 첫 메시지의 신뢰 등급으로 승격시키지 않는다 — orchestratorMemory와 같은 원칙).
 */

/** 기록 전체의 바이트 예산. 한국어 밀도 실측(≈3.3B/토큰)으로 ≈45K 토큰 ≈ 컨텍스트의 ~22% */
export const RECORD_BUDGET = 150_000
/** 강등에서 보호되는 최근 항목 수 — 전임자의 "지금 머릿속" */
const RECENT_KEEP = 30
/** 강등된 assistant 메시지가 남기는 머리 길이 */
const HEAD_CHARS = 500
/** 요약 단독 상한 — 불가침이지만 무한은 아니다 */
const SUMMARY_CAP = 120_000

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

type Entry = { text: string; demotable: boolean; seq: number }

/** 행들을 읽히는 줄로 — 툴은 한 줄, 추론·승인·마커는 소음이라 뺀다 */
function toEntries(rows: StoredMessage[]): Entry[] {
  const out: Entry[] = []
  // tool_result가 자기 호출 줄에 → ok/failed로 눕도록 callId로 짝을 찾는다
  const byCall = new Map<string, Entry>()
  for (const r of rows) {
    const p = r.payload as { text?: string; callId?: string; ok?: boolean; summary?: { tool?: string; title?: string } }
    if (r.kind === 'text') {
      const text = (p.text ?? '').trim()
      if (!text) continue
      out.push({ text: `[${r.role}] ${text}`, demotable: r.role === 'assistant', seq: r.seq })
    } else if (r.kind === 'image') {
      out.push({ text: '[user] (image attached)', demotable: false, seq: r.seq })
    } else if (r.kind === 'tool_call') {
      const e: Entry = {
        text: `[tool] ${p.summary?.tool ?? '?'}: ${p.summary?.title ?? ''}`.trimEnd(),
        demotable: false,
        seq: r.seq,
      }
      out.push(e)
      if (p.callId) byCall.set(p.callId, e)
    } else if (r.kind === 'tool_result') {
      const call = p.callId ? byCall.get(p.callId) : undefined
      if (call) call.text += ` → ${p.ok === false ? 'failed' : 'ok'}`
    }
    // reasoning·approval·marker: 후임자의 첫 메시지에 실을 정보가 아니다
  }
  return out
}

const demote = (e: Entry) => {
  if (e.demotable && e.text.length > HEAD_CHARS) e.text = e.text.slice(0, HEAD_CHARS) + '…'
}

export function buildHandoffRecord(opts: {
  name: string
  tool: string
  /** 도구의 마지막 컴팩트 요약 원문 (codex 롤아웃에서). null이면 요약 섹션이 없다 */
  summary: string | null
  /** 세션의 **전체** 행, 시간순 — 피벗 앞뒤 처리는 여기서 한다 */
  rows: StoredMessage[]
  /** 마지막 성공한 컴팩트 마커의 seq. null이면 컴팩트된 적 없는 세션 */
  pivotSeq: number | null
  budget?: number
}): string {
  const budget = opts.budget ?? RECORD_BUDGET

  const header = [
    '# CentralU Handoff Record (automatic)',
    '',
    `Your predecessor session "${opts.name}" (${opts.tool}) could not respond, so the app`,
    'built this record from its stored conversation. It is raw material, not a curated',
    'briefing — digest it yourself, then continue the work. Reply first with a short',
    'summary of your understanding of the current state. Match the language the',
    'conversation itself uses.',
    'Tool calls appear as one-line traces only: re-read files and re-run commands',
    'yourself instead of assuming their old output.',
    '',
  ].join('\n')

  // 요약은 불가침이지만 무한은 아니다 — 병적인 크기만 예외적으로 자른다
  const fullSummary = opts.summary?.trim() || null
  let summary = fullSummary
  if (summary) {
    while (bytes(summary) > Math.min(SUMMARY_CAP, budget - 2_000)) {
      summary = summary.slice(0, Math.floor(summary.length * 0.9))
    }
    if (summary.length < fullSummary!.length) summary += '\n…[summary truncated to fit]'
  }
  const summarySection = summary ? `## The tool's last compaction summary\n\n${summary}\n\n` : ''

  let entries = toEntries(opts.rows)
  let omitted = 0
  if (summary && opts.pivotSeq != null) {
    // 요약이 피벗 이전을 대신한다 — 같은 내용을 원문으로 또 실으면 예산만 태운다
    omitted = entries.filter((e) => e.seq <= opts.pivotSeq!).length
    entries = entries.filter((e) => e.seq > opts.pivotSeq!)
  } else if (opts.pivotSeq != null) {
    // 요약이 없으면 피벗 이전도 싣되, 전임자의 컨텍스트에서 이미 접혀 있던 부분이라 즉시 강등
    for (const e of entries) if (e.seq <= opts.pivotSeq) demote(e)
  }
  const convHeader = summary ? '## Conversation since then\n\n' : '## Conversation\n\n'

  const fixed = bytes(header + summarySection + convHeader) + 200 // 탈락 문구 몫의 슬랙
  const total = () => entries.reduce((n, e) => n + bytes(e.text) + 2, fixed)

  // 사다리 3: 오래된 assistant부터 머리만 남긴다 (최근 RECENT_KEEP개는 원문 보장)
  if (total() > budget) for (const e of entries.slice(0, Math.max(0, entries.length - RECENT_KEEP))) demote(e)
  // 사다리 4: 그래도 넘치면 오래된 것부터 탈락 — 탈락분은 DB에 남는다
  while (total() > budget && entries.length > 1) {
    entries.shift()
    omitted++
  }

  // 탈락 문구는 시간적으로 구멍이 난 자리(대화 머리)에 선다 — 끝에 붙으면 못 보고 지나간다
  const droppedNote =
    omitted > 0
      ? `(${omitted} earlier message${omitted === 1 ? '' : 's'} not included here — they remain in the app's records.)\n\n`
      : ''

  return header + summarySection + convHeader + droppedNote + entries.map((e) => e.text).join('\n\n')
}
