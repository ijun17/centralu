import type { ExternalSessionSummary, HistoryMessage } from '../contract.js'
import { cleanTitle, stripInjectedBlocks } from '../history-text.js'

/**
 * Claude Code가 보관 중인 이전 세션 읽기.
 *
 * **공식 SDK API만 쓴다** (`listSessions` / `getSessionMessages`).
 * `~/.claude/projects/**\/*.jsonl`을 직접 파싱하지 않는다 — 그 파일 포맷은
 * 문서화된 계약이 아니라서 도구가 올라가면 소리 없이 깨지고, 깨진 줄도 모른다.
 * SDK는 자기 버전이 쓴 트랜스크립트를 스스로 읽으므로 버전 호환은 SDK의 몫이 된다.
 *
 * 다만 **SDK 자체가 낡을 수는 있다**(구버전 lockfile로 설치된 환경).
 * 그래서 named import 대신 동적 import + 함수 존재 확인으로 접근한다:
 * 없으면 모듈 로드 자체가 터지는 대신 '지원하지 않음'으로 물러난다.
 */

export const UNSUPPORTED =
  'The installed Claude Code SDK does not support listing past sessions (update the SDK)'

/** SDK 표면 중 우리가 쓰는 부분만. 여기 없는 필드는 있어도 무시한다 (앞으로 늘어나도 안전) */
type SdkSessionInfo = {
  sessionId?: unknown
  summary?: unknown
  customTitle?: unknown
  firstPrompt?: unknown
  lastModified?: unknown
  createdAt?: unknown
  gitBranch?: unknown
}
type SdkSessionMessage = { type?: unknown; message?: unknown }
type SessionApi = {
  listSessions?: (o?: Record<string, unknown>) => Promise<SdkSessionInfo[]>
  getSessionMessages?: (id: string, o?: Record<string, unknown>) => Promise<SdkSessionMessage[]>
}

let cached: SessionApi | null | undefined

async function sessionApi(): Promise<SessionApi | null> {
  if (cached !== undefined) return cached
  try {
    const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SessionApi
    cached = typeof mod.listSessions === 'function' ? mod : null
  } catch {
    cached = null
  }
  return cached
}

/** 테스트에서 SDK 표면을 갈아 끼운다 (구버전·미지원 상황을 재현하기 위해) */
export function __setSessionApiForTest(api: SessionApi | null | undefined): void {
  cached = api
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export async function listClaudeSessions(cwd: string, limit: number): Promise<ExternalSessionSummary[]> {
  const sdk = await sessionApi()
  if (!sdk?.listSessions) throw new Error(UNSUPPORTED)
  /*
   * includeProgrammatic:true — SDK로 만든 세션(=Control Center가 만든 것)까지 포함한다.
   *
   * 처음에는 false로 걸렀다. "우리가 만든 건 이미 사이드바에 있으니 중복"이라는 이유였는데,
   * **숨김의 의미가 '목록에서 치우기'가 되면서 그 전제가 깨졌다** —
   * 숨긴 세션은 사이드바에 없고, 여기서도 안 보이면 되돌릴 길이 사라진다.
   * (실측: 우리가 만든 세션은 false에서 0건, true에서 1건으로 나왔다)
   *
   * 중복은 목록의 imported 표시로 거른다.
   */
  const rows = await sdk.listSessions({ dir: cwd, limit, includeProgrammatic: true })
  if (!Array.isArray(rows)) return []
  const out: ExternalSessionSummary[] = []
  for (const r of rows) {
    const id = str(r?.sessionId)
    if (!id) continue
    out.push({
      externalId: id,
      // 제목 후보에도 하네스가 주입한 블록이 섞여 온다 (실측) — 걷어낸 뒤 고른다
      title:
        [r.customTitle, r.summary, r.firstPrompt]
          .map((c) => (typeof c === 'string' ? cleanTitle(c) : ''))
          .find((c) => c.length > 0) ?? 'Untitled session',
      updatedAt: num(r.lastModified) ?? Date.now(),
      createdAt: num(r.createdAt),
      branch: str(r.gitBranch),
    })
  }
  return out
}

export async function readClaudeHistory(
  externalId: string,
  cwd: string,
  limit: number,
): Promise<HistoryMessage[]> {
  const sdk = await sessionApi()
  if (!sdk?.getSessionMessages) throw new Error(UNSUPPORTED)
  const rows = await sdk.getSessionMessages(externalId, { dir: cwd, limit })
  if (!Array.isArray(rows)) return []
  const out: HistoryMessage[] = []
  for (const r of rows) {
    const role = r?.type === 'user' ? 'user' : r?.type === 'assistant' ? 'assistant' : null
    if (!role) continue
    // 사용자 턴에서만 걷어낸다 — 모델의 말에 든 태그는 모델이 실제로 쓴 것이다
    const raw = textOf(r.message)
    const text = role === 'user' ? stripInjectedBlocks(raw) : raw
    if (!text) continue
    out.push({ role, text })
  }
  return out
}

/**
 * Anthropic 메시지 → 화면에 보일 텍스트.
 *
 * 도구 호출/결과는 일부러 버린다. 불러오기의 목적은 **대화를 되찾는 것**이지
 * 실행 로그를 되살리는 게 아니다 — 로그까지 끌고 오면 스크롤만 길어지고
 * 정작 무슨 얘기를 했는지가 묻힌다. (도구 이름만 한 줄로 남긴다)
 */
function textOf(message: unknown): string {
  if (typeof message === 'string') return message.trim()
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    const block = b as { type?: unknown; text?: unknown; name?: unknown }
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool_use' && typeof block.name === 'string') parts.push(`\`${block.name}\``)
  }
  return parts.join('\n\n').trim()
}
