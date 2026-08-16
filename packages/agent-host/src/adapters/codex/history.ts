import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'
import { CodexClient } from './client.js'

/**
 * Codex가 보관 중인 이전 스레드 읽기.
 *
 * **공식 app-server RPC만 쓴다** (`thread/list` · `thread/read`).
 * `~/.codex/sessions/**\/rollout-*.jsonl`을 직접 파싱하지 않는다 —
 * 롤아웃 포맷은 내부 구현이고, 그걸 우리가 따라다니기 시작하면
 * codex가 올라갈 때마다 조용히 틀린 대화를 보여주게 된다.
 *
 * 구버전 codex는 이 메서드를 모른다 → JSON-RPC "method not found"가 온다.
 * 그건 예외가 아니라 **정상적인 협상 결과**로 취급해 상위에 이유를 넘긴다.
 */

export const UNSUPPORTED =
  '설치된 Codex가 이전 세션 목록을 지원하지 않습니다 (codex 업데이트가 필요합니다)'

/** 구버전이 모르는 메서드를 불렀을 때의 응답. 문구는 버전마다 달라서 넓게 본다 */
export function isUnknownMethod(err: unknown): boolean {
  const m = (err as Error | null)?.message ?? ''
  return /-32601|method not found|unknown method|unsupported method|not supported/i.test(m)
}

/**
 * 목록 조회용 단명 클라이언트. 세션 프로세스와 섞지 않는다 —
 * 대화 중인 스레드에 조회 트래픽을 얹으면 그쪽이 느려지고,
 * 실패했을 때 어느 쪽이 죽은 건지 구분이 안 된다.
 */
async function withClient<T>(cwd: string, command: string, fn: (c: CodexClient) => Promise<T>): Promise<T> {
  const client = new CodexClient(
    { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
    { cwd, command },
  )
  try {
    await client.request('initialize', {
      clientInfo: { name: 'control-center', title: 'Control Center', version: '0.1.0' },
      capabilities: null,
    })
    client.notify('initialized')
    return await fn(client)
  } finally {
    await client.dispose().catch(() => {})
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** codex는 초 단위 유닉스 시각을 쓴다 — 우리 저장 단위는 ms다 */
const ms = (sec: unknown): number | undefined => {
  const n = num(sec)
  return n === undefined ? undefined : Math.round(n * 1000)
}

export async function listCodexThreads(
  cwd: string,
  limit: number,
  command: string,
): Promise<ExternalSessionSummary[]> {
  return withClient(cwd, command, async (client) => {
    let res: { data?: unknown }
    try {
      res = await client.request<{ data?: unknown }>('thread/list', {
        cwd,
        limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      })
    } catch (err) {
      throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
    }
    return threadListToSummaries(res?.data, cwd)
  })
}

export async function readCodexHistory(
  externalId: string,
  cwd: string,
  limit: number,
  command: string,
): Promise<HistoryMessage[]> {
  return withClient(cwd, command, async (client) => {
    let res: { thread?: unknown }
    try {
      res = await client.request<{ thread?: unknown }>('thread/read', {
        threadId: externalId,
        includeTurns: true,
      })
    } catch (err) {
      throw isUnknownMethod(err) ? new Error(UNSUPPORTED) : err
    }
    const thread = (res?.thread ?? {}) as Record<string, unknown>
    return turnsToHistory(thread.turns, limit)
  })
}

/**
 * thread/list 응답 → 요약 목록.
 * 응답 파싱은 순수 함수로 분리해 둔다 — codex를 띄우지 않고도 검증할 수 있어야
 * 포맷이 바뀌었을 때 테스트가 먼저 알려준다.
 */
export function threadListToSummaries(data: unknown, cwd: string): ExternalSessionSummary[] {
  const rows = Array.isArray(data) ? data : []
  const out: ExternalSessionSummary[] = []
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>
    const id = str(row.id)
    if (!id) continue
    // cwd 필터는 서버가 하지만, 구버전이 무시할 수 있으므로 한 번 더 거른다
    if (str(row.cwd) && str(row.cwd) !== cwd) continue
    out.push({
      externalId: id,
      /*
       * preview는 codex 기준 '보통 **첫** 사용자 메시지'다.
       * 즉 며칠 이어온 대화도 맨 처음 주제로 표시된다 — Claude가 요약을 주는 것과 다르다.
       * 목록을 만들면서 마지막 메시지를 가져오려면 스레드마다 thread/read를 해야 해서
       * 타이핑 응답으로 쓸 수 없다. 그래서 제목은 이대로 두고,
       * UI가 "마지막 N시간 전"을 함께 적어 최신 여부를 알 수 있게 한다.
       * (하네스가 주입한 지시문이 섞여 오는 경우가 있어 그것만 걷어낸다)
       */
      title: cleanTitle(str(row.preview) ?? '') || '제목 없는 세션',
      updatedAt: ms(row.updatedAt) ?? ms(row.recencyAt) ?? Date.now(),
      createdAt: ms(row.createdAt),
    })
  }
  return out
}

/** thread/read의 turns → 대화 줄 목록. 넘치면 오래된 쪽부터 자른다 */
export function turnsToHistory(turns: unknown, limit: number): HistoryMessage[] {
  const list = Array.isArray(turns) ? turns : []
  const out: HistoryMessage[] = []
  for (const t of list) {
    const turn = (t ?? {}) as Record<string, unknown>
    const at = ms(turn.startedAt)
    const items = Array.isArray(turn.items) ? turn.items : []
    for (const i of items) {
      const msg = itemToMessage(i, at)
      if (msg) out.push(msg)
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out
}

/**
 * ThreadItem → 대화 한 줄.
 *
 * 우리가 아는 두 종류(userMessage·agentMessage)만 집는다.
 * 나머지(reasoning·commandExecution·fileChange…)는 **모르는 채로 흘려보낸다** —
 * codex가 항목 종류를 추가해도 여기서 터지지 않고 그냥 안 보일 뿐이다.
 */
function itemToMessage(item: unknown, ts?: number): HistoryMessage | null {
  const it = (item ?? {}) as Record<string, unknown>
  if (it.type === 'agentMessage') {
    const text = str(it.text)
    return text ? { role: 'assistant', text, ts } : null
  }
  if (it.type === 'userMessage') {
    const text = stripInjectedBlocks(userInputText(it.content))
    return text ? { role: 'user', text, ts } : null
  }
  return null
}

/** UserInput[]에서 사람이 친 텍스트만. 이미지·파일 첨부는 표시에서 뺀다 */
function userInputText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    const block = (c ?? {}) as Record<string, unknown>
    const text = str(block.text)
    if (text && (block.type === 'text' || block.type === 'input_text' || block.type === undefined)) {
      parts.push(text)
    }
  }
  return parts.join('\n\n').trim()
}
