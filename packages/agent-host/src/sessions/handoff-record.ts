import type { StoredMessage } from '@cc/protocol'

/**
 * 인수인계 기록 (#78) — **요약자 없는 인수인계**, 그리고 그 결과는 **파일이다** (#102).
 *
 * 살아 있는 인수인계는 죽는 에이전트가 노트를 쓴다. 서비스가 중단되면 그 길이
 * 막히는데, 대화 원문은 우리 저장소에 컴팩션 없이 전부 남아 있다. 이 모듈은
 * 그 원문을 후임자가 읽을 수 있는 글로 물질화한다 — LLM 없이, 결정론적으로.
 *
 * **더는 한 통의 채팅 메시지에 맞추지 않는다** (#102). 예전 이 파일에는 사다리가
 * 있었다: 오래된 답변을 앞 500자로 강등하고, 요약을 줄이고, 그래도 넘치면 앞에서부터
 * 버렸다. 그 사다리가 존재한 이유는 단 하나 — 결과를 initialPrompt 한 통으로 보냈기
 * 때문이다. 이제 host가 이 글을 프로젝트의 `.centralu-handoff.md`로 쓰고 후임자는
 * 경로만 받는다. 맞출 봉투가 없으므로 균일한 열화도 필요 없다.
 *
 * **무엇이 부피인가는 실측이다** (#102): tool_result 45% + tool_call 43% = 88%.
 * 사람이 한 말은 8%뿐이다. 행 하나는 작고(tool_result 평균 0.6KB) 문제는 **개수**라서,
 * 본문을 깎는 대신 **행을 접는다** — 최근순 3단.
 *
 * **경계는 선언한다.** 균일하게 열화된 글은 온전해 보이면서 온전하지 않고, 읽는
 * 쪽에 그것을 알 방법이 없다. 그래서 최근 것부터 상한까지 담고, 어디까지 담았는지를
 * 첫 줄에 적는다. 자르기가 정당한 이유는 원문이 저장소에 그대로 남아 있기 때문이다:
 * 이 파일은 **사본이 아니라 뷰**이고, 더 넓은 뷰는 언제든 다시 만들 수 있다.
 *
 * **피벗은 선택이다.** 마지막 컴팩트 마커가 있으면 거기서부터 담고 도구의 요약을
 * 그 위에 올린다. 실측: codex 세션에는 우리 저장소에 컴팩션 마커가 **하나도 없다**
 * (컴팩션이 자기 롤아웃 파일에서 일어난다). 피벗을 전제하는 규칙은 claude에서만
 * 성립하므로, 없으면 그냥 최근 상한만 적용한다.
 */

/**
 * 기록 파일의 바이트 상한. 2MB = 실측 전사 20만 행 중 최근 수만 행이 들어가는 크기이자,
 * 사람이 `rg`로 뒤지기에 아무 부담이 없는 크기다. 메시지 봉투가 아니라 **파일** 상한이라
 * 컨텍스트가 아니라 디스크·읽기 비용만 제한한다.
 */
export const RECORD_CAP = 2_000_000

/**
 * 최근 툴 호출 몇 개를 결과 본문까지 그대로 실을까.
 * 40 ≈ 전임자의 마지막 두어 턴 — "머리에 들고 있던 것"의 실측 폭이다.
 * (평균 0.6KB × 40 ≈ 25KB. 여기까지가 다시 돌려보지 않고도 믿을 만한 범위다.)
 */
const TOOLS_VERBATIM = 40
/**
 * 그 앞 몇 개를 한 줄 흔적으로 남길까.
 * 1,000 ≈ 하루치 작업. 한 줄이 ~70B라 1,000줄이어도 70KB로, 상한의 3%다 —
 * "무엇을 어느 파일에 했는가"의 연대기는 이 값이면 거의 끊기지 않는다.
 */
const TOOLS_LINE = 1_000
/** 헤더·접힘 줄에 적는 파일 경로 개수 상한 — 목록이 본문을 밀어내면 목록이 아니다 */
const TOUCHED_MAX = 60

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')
const num = (n: number) => n.toLocaleString('en-US')
const distinct = (xs: string[]) => [...new Set(xs)]

type ToolEntry = {
  kind: 'tool'
  seq: number
  tool: string
  title: string
  paths: string[]
  /** null이면 결과가 아직 안 붙은 호출 (턴 중간에 끊긴 세션) */
  ok: boolean | null
  result: string
}
type TextEntry = { kind: 'text'; seq: number; text: string }
type Entry = ToolEntry | TextEntry

/** 행들을 항목으로 — 추론·승인·마커는 후임자가 읽을 것이 아니라 뺀다 */
function toEntries(rows: StoredMessage[]): Entry[] {
  const out: Entry[] = []
  // tool_result가 자기 호출 항목에 눕도록 callId로 짝을 찾는다
  const byCall = new Map<string, ToolEntry>()
  for (const r of rows) {
    const p = r.payload as { text?: string; callId?: string; ok?: boolean; summary?: unknown }
    if (r.kind === 'text') {
      const text = (p.text ?? '').trim()
      if (!text) continue
      out.push({ kind: 'text', seq: r.seq, text: `[${r.role}] ${text}` })
    } else if (r.kind === 'image') {
      out.push({ kind: 'text', seq: r.seq, text: '[user] (image attached)' })
    } else if (r.kind === 'tool_call') {
      const s = (p.summary ?? {}) as { tool?: string; title?: string; paths?: string[] }
      const e: ToolEntry = {
        kind: 'tool',
        seq: r.seq,
        tool: s.tool ?? '?',
        title: s.title ?? '',
        paths: s.paths ?? [],
        ok: null,
        result: '',
      }
      out.push(e)
      if (p.callId) byCall.set(p.callId, e)
    } else if (r.kind === 'tool_result') {
      const call = p.callId ? byCall.get(p.callId) : undefined
      if (call) {
        call.ok = p.ok !== false
        call.result = typeof p.summary === 'string' ? p.summary.trim() : ''
      }
    }
  }
  return out
}

const isTool = (e: Entry): e is ToolEntry => e.kind === 'tool'

/**
 * 한 줄 흔적 — `[38817] Edit packages/ui/src/store/store.ts (ok)`.
 * 줄머리의 seq는 자릿점을 찍지 않는다: 이건 세는 수가 아니라 **찾는 이름**이라,
 * 기록에서 그 행을 다시 꺼내려는 사람이 그대로 검색할 수 있어야 한다.
 */
const toolLine = (e: ToolEntry) =>
  `[${e.seq}] ${e.tool}${e.title ? ` ${e.title}` : ''}${e.ok == null ? '' : e.ok ? ' (ok)' : ' (failed)'}`

const indent = (s: string) => s.replace(/^/gm, '    ')

/** 가장 오래된 툴 무리는 세어서 한 덩어리로 — 개수와 손댄 파일만 남는다 */
function collapsedLine(list: ToolEntry[]): string {
  const counts = new Map<string, number>()
  for (const e of list) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1)
  const kinds = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `${t} ×${num(n)}`)
    .join(', ')
  const paths = distinct(list.flatMap((e) => e.paths)).slice(0, TOUCHED_MAX)
  const where = paths.length ? ` — ${paths.join(', ')}` : ''
  return `[${list[0]!.seq}–${list[list.length - 1]!.seq}] ${num(list.length)} earlier tool calls (${kinds})${where}`
}

/** 최근에 손댄 파일부터 — 후임자가 가장 먼저 찾는 것이고, 뽑는 값은 공짜다 */
function touchedPaths(entries: Entry[]): string[] {
  const seen: string[] = []
  for (let i = entries.length - 1; i >= 0 && seen.length < TOUCHED_MAX; i--) {
    const e = entries[i]!
    if (!isTool(e)) continue
    for (const p of e.paths) if (!seen.includes(p)) seen.push(p)
  }
  return seen.slice(0, TOUCHED_MAX)
}

export function buildHandoffRecord(opts: {
  name: string
  tool: string
  /** 후임자가 될 도구. 모르면 생략 — 헤더가 화살표 없이 전임 도구만 적는다 */
  toTool?: string
  /** 도구의 마지막 컴팩트 요약 원문 (codex 롤아웃에서). null이면 요약 섹션이 없다 */
  summary: string | null
  /** 세션의 **전체** 행, 시간순 — 피벗 앞뒤 처리는 여기서 한다 */
  rows: StoredMessage[]
  /** 마지막 성공한 컴팩트 마커의 seq. null이면 피벗 없이 최근 상한만 적용한다 */
  pivotSeq: number | null
  cap?: number
}): string {
  const cap = opts.cap ?? RECORD_CAP
  const all = toEntries(opts.rows)
  const lastSeq = opts.rows.length ? opts.rows[opts.rows.length - 1]!.seq : 0

  // 요약이 **있을 때만** 피벗 이전을 접는다 — 요약 없이 버리면 그 구간이 어디에도 없다
  const summary = opts.summary?.trim() || null
  const folded = summary != null && opts.pivotSeq != null
  const entries = folded ? all.filter((e) => e.seq > opts.pivotSeq!) : all

  /*
   * 3단 접기. 단은 **툴 항목만** 세고, 사람이 한 말은 어느 단에서도 손대지 않는다 —
   * 부피의 88%가 툴이고 8%가 말이라, 말을 깎아서 버는 것이 없다.
   */
  const tools = entries.filter(isTool)
  const verbatimFrom = Math.max(0, tools.length - TOOLS_VERBATIM)
  const lineFrom = Math.max(0, verbatimFrom - TOOLS_LINE)
  const verbatim = new Set(tools.slice(verbatimFrom))
  const collapsing = tools.slice(0, lineFrom)
  const collapsed = new Set(collapsing)

  const rendered: { seq: number; text: string }[] = []
  let collapseWritten = false
  for (const e of entries) {
    if (!isTool(e)) {
      rendered.push({ seq: e.seq, text: e.text })
      continue
    }
    if (collapsed.has(e)) {
      // 접힌 무리는 처음 만난 자리에 한 줄로 선다 — 시간 순서 안에 남아야 읽힌다
      if (!collapseWritten) {
        collapseWritten = true
        rendered.push({ seq: e.seq, text: collapsedLine(collapsing) })
      }
      continue
    }
    const head = toolLine(e)
    rendered.push({ seq: e.seq, text: verbatim.has(e) && e.result ? `${head}\n${indent(e.result)}` : head })
  }

  const instructions = [
    `Your predecessor session "${opts.name}" (${opts.tool}) could not respond, so the app`,
    'built this record from its stored conversation. It is raw material, not a curated',
    'briefing — digest it yourself, then continue the work. Reply first with a short',
    'summary of your understanding of the current state. Match the language the',
    'conversation itself uses.',
    'Older tool calls appear as one-line traces: re-read files and re-run commands',
    'yourself instead of assuming their old output.',
    '',
  ].join('\n')
  const touched = touchedPaths(all)
  const touchedLine = touched.length ? `touched: ${touched.join(', ')}\n` : ''
  const summarySection = summary ? `## The tool's last compaction summary\n\n${summary}\n\n` : ''
  const verbatimMark = '── verbatim from here ──\n\n'

  /*
   * 상한은 **최근부터** 채운다. 담긴 항목 안을 잘라 내지 않는 것이 규칙이다 —
   * 반쯤 잘린 항목은 온전한 척하지만, 통째로 빠진 구간은 첫 줄이 말해 준다.
   */
  const fixed = bytes(instructions + touchedLine + summarySection + verbatimMark) + 200 // covers 줄 몫의 슬랙
  const size = () => rendered.reduce((n, e) => n + bytes(e.text) + 2, fixed)
  let dropped = 0
  while (size() > cap && rendered.length > 1) {
    rendered.shift()
    dropped++
  }

  const from = rendered.length ? rendered[0]!.seq : lastSeq
  const covers =
    `covers seq ${num(from)}–${num(lastSeq)} of ${num(lastSeq)}` +
    ` · ${(cap / 1_000_000).toFixed(1)} MB cap` +
    (dropped > 0 || folded ? " · earlier material stays in the app's records" : '')
  const header = `# Handoff · ${opts.name} · ${opts.tool}${opts.toTool ? ` → ${opts.toTool}` : ''}\n${covers}\n${touchedLine}\n`

  return header + instructions + summarySection + verbatimMark + rendered.map((e) => e.text).join('\n\n') + '\n'
}
