import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * 입력창 자동완성 — `/`는 스킬, `@`는 파일.
 *
 * 목록의 출처가 다르다는 걸 UI는 몰라도 된다:
 *   스킬은 각 도구의 공식 API(Claude supportedCommands · Codex skills/list),
 *   파일은 host가 프로젝트 색인에서 찾는다.
 *
 * 두 가지를 지킨다:
 *  1. **입력을 막지 않는다.** 목록을 못 가져와도 타이핑과 전송은 그대로 된다.
 *  2. **'없음'과 '아직'을 구분한다.** 세션을 막 만들면 도구가 뜨는 중이라
 *     스킬을 물어볼 수 없는데, 그때 빈 목록을 보여주면 스킬이 없는 것처럼 보인다.
 */

export type Suggestion = { value: string; label: string; hint: string }

/** 구독하지 않을 때 돌려줄 **고정된** 빈 지도 — 매번 새 객체면 memo도 selector도 소용없다 */
const EMPTY_MAP: Record<string, never> = {}

/**
 * 슬래시 명령 점수. 높을수록 위. null이면 목록에서 뺀다.
 *
 * 규칙은 사람이 치는 방식에서 나온다:
 *  - `usage`를 다 쳤으면 찾는 건 `usage`이지 `usage-credit`이 아니다 → **정확히 일치가 최상위**
 *  - 앞글자를 치는 건 이름의 **시작**을 떠올린 것이다 → 앞에서 시작하는 쪽이 위
 *  - 한두 글자만 쳤을 때 이름 중간에 그 글자가 있다고 끼어들면 목록이 쓸모없어진다
 *    (`u` 하나에 `docs-lookup`이 뜨는 식) → 짧은 질의는 시작·경계 매치만 받는다
 */
export function scoreCommand(name: string, query: string): number | null {
  const n = name.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 100 - Math.min(n.length, 40)

  if (n === q) return 1000
  if (n.startsWith(q)) return 800 - Math.min(n.length - q.length, 60)

  // `-`·`:`·`_` 뒤도 이름의 시작으로 친다 (usage-credit에서 credit)
  const boundary = n.split(/[-:_/]/).some((part) => part.startsWith(q))
  if (boundary) return 500 - Math.min(n.length, 60)

  // 짧은 질의에서 중간 매치는 소음이다
  if (q.length <= 2) return null
  return n.includes(q) ? 200 - Math.min(n.length, 60) : null
}

/** 커서 앞의 글자에서 자동완성 대상을 알아낸다 */
export function detectTrigger(
  text: string,
  caret: number,
): { kind: 'command' | 'file'; query: string; start: number } | null {
  const before = text.slice(0, caret)

  // 슬래시 명령은 **맨 앞에서만** 시작한다 — 문장 중간의 경로(`src/a.ts`)를 명령으로 보면 안 된다
  const slash = /^\/([\w:-]*)$/.exec(before)
  if (slash) return { kind: 'command', query: slash[1] ?? '', start: 0 }

  // @는 어디서든. 단 공백 뒤(또는 맨 앞)에서 시작한 것만 — 이메일 주소를 잡지 않는다
  const at = /(^|\s)@([^\s]*)$/.exec(before)
  if (at) return { kind: 'file', query: at[2] ?? '', start: caret - (at[2] ?? '').length - 1 }

  return null
}

export function useAutocomplete({
  sessionId,
  projectId,
  text,
  caret,
  enabled,
  atSource = 'files',
}: {
  sessionId: string
  projectId: string
  text: string
  caret: number
  enabled: boolean
  /**
   * `@`가 무엇을 가리키나.
   *
   * 오케스트레이터에게 파일은 의미가 없다 — 손이 없어서 파일을 만지지 않는다.
   * 대신 `@`는 **세션**을 집는다: 말로 지목하면 이름을 잘못 짚을 수 있고,
   * 엉뚱한 세션에 일이 가면 그 프로젝트가 실제로 바뀐다.
   */
  atSource?: 'files' | 'sessions'
}) {
  const platform = usePlatform()
  const [commands, setCommands] = useState<{ ready: boolean; commands: CommandInfo[] }>({
    ready: false,
    commands: [],
  })
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [index, setIndex] = useState(0)

  const trigger = useMemo(() => (enabled ? detectTrigger(text, caret) : null), [enabled, text, caret])

  /*
   * 세션 목록은 이미 스토어에 있다 — 오케스트레이터의 `@`는 여기서 고른다.
   *
   * **`@`를 치고 있을 때만 구독한다.** `s.sessions`는 세션 하나가 숨만 쉬어도 통째로
   * 새 객체가 되는 지도라, 그냥 구독해 두면 답변이 흐르는 동안 델타마다 이 훅이
   * 다시 돌고 그걸 쓰는 입력창까지 같이 다시 그려졌다 (실측: 답변 중 2.0 렌더/글자).
   * 정작 이 값이 필요한 순간은 메뉴가 열려 있는 몇 초뿐이다.
   */
  const wantSessions = atSource === 'sessions' && trigger?.kind === 'file'
  const sessionMap = useStore((s) => (wantSessions ? s.sessions : EMPTY_MAP))
  const projectMap = useStore((s) => (wantSessions ? s.projects : EMPTY_MAP))
  const sessions = useMemo(() => Object.values(sessionMap), [sessionMap])
  const projectNames = useMemo(
    () => Object.fromEntries(Object.values(projectMap).map((p) => [p.id, p.name])),
    [projectMap],
  )

  /*
   * The command list is asked for twice at most, and the second ask is the honest one.
   *
   * A sleeping session can only answer from the disk cache, and a cache answers with what
   * was true last time — it served a plugin's commands for days after the plugin was
   * uninstalled. So the cached answer renders immediately (an empty menu while a process
   * boots is worse), and the moment the session comes alive — which composer focus now
   * starts (warmSession) — the list is fetched once more from the tool itself.
   */
  const live = useStore((s) => !!s.sessions[sessionId]?.live)
  const fetchedLive = useRef(false)
  useEffect(() => {
    if (trigger?.kind !== 'command') return
    if (commands.ready && (fetchedLive.current || !live)) return
    let alive = true
    const askedWhileLive = live
    void platform.agents
      .commands(sessionId)
      .then((r) => {
        if (!alive) return
        fetchedLive.current = askedWhileLive
        setCommands(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trigger?.kind, commands.ready, live, platform, sessionId])

  // 포커스 뷰의 SessionPane은 key 없이 세션만 갈아끼운다 — 이전 세션의 목록을 들고 있으면 안 된다
  useEffect(() => {
    fetchedLive.current = false
    setCommands({ ready: false, commands: [] })
  }, [sessionId])

  // 파일은 칠 때마다 찾는다 (host가 색인을 들고 있어 빠르다)
  useEffect(() => {
    if (trigger?.kind !== 'file' || atSource !== 'files') return
    let alive = true
    void platform.fs
      .search(projectId, trigger.query, 20)
      .then((r) => alive && setFiles(r))
      .catch(() => alive && setFiles([]))
    return () => {
      alive = false
    }
  }, [trigger?.kind, trigger?.query, platform, projectId, atSource])

  const items = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    if (trigger.kind === 'command') {
      /*
       * 자르지 않는다. 한때 상위 20개만 남겼는데, 빈 질의 정렬이 짧은 이름 우선이라
       * 이름이 긴 플러그인 스킬(openai-templates:* 스물한 개)이 **통째로** 잘렸다 —
       * 화면에는 그냥 "없는 것"으로 보였고, 실제로 그렇게 보고됐다. 목록은 이미
       * 스크롤(max-h-56)이라 길어서 잃는 것이 없고, 실측 최대 102개는 가상 스크롤이
       * 필요한 크기가 아니다.
       */
      return (
        commands.commands
          .map((c) => ({ c, s: scoreCommand(c.name, trigger.query) }))
          .filter((x): x is { c: CommandInfo; s: number } => x.s !== null)
          // 점수가 같으면 짧은 이름이 위 — 대개 그쪽이 원래 찾던 것이다
          .sort((a, b) => (b.s === a.s ? a.c.name.length - b.c.name.length : b.s - a.s))
          .map(({ c }) => ({
            value: `/${c.name} `,
            label: `/${c.name}`,
            hint: c.argumentHint || c.description,
          }))
      )
    }
    if (atSource === 'sessions') {
      const q = trigger.query.toLowerCase()
      return sessions
        .filter((x) => !x.archived && x.projectId !== null && x.name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((x) => ({ value: `@${x.name} `, label: x.name, hint: projectNames[x.projectId!] ?? '' }))
    }
    return files.map((f) => ({ value: `@${f.path} `, label: f.name, hint: f.path }))
  }, [trigger, commands, files, atSource, sessions, projectNames])

  // 목록이 바뀌면 첫 항목으로 되돌린다 — 커서가 엉뚱한 곳에 남아 있으면 잘못 고른다
  useEffect(() => {
    setIndex(0)
  }, [trigger?.kind, trigger?.query])

  const apply = useCallback(
    (item: Suggestion): { text: string; caret: number } => {
      if (!trigger) return { text, caret }
      const next = text.slice(0, trigger.start) + item.value + text.slice(caret)
      return { text: next, caret: trigger.start + item.value.length }
    },
    [trigger, text, caret],
  )

  const loading = trigger?.kind === 'command' && !commands.ready

  return {
    open: !!trigger && (items.length > 0 || loading),
    kind: trigger?.kind ?? null,
    items,
    index,
    loading,
    move: (delta: number) =>
      setIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length)),
    apply,
  }
}

export function AutocompleteMenu({
  items,
  index,
  loading,
  kind,
  onPick,
}: {
  items: Suggestion[]
  index: number
  loading: boolean
  kind: 'command' | 'file' | null
  onPick: (item: Suggestion) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)

  // 키보드로 내려가면 화면 밖으로 나가지 않게 따라간다
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-1 w-full overflow-hidden rounded border border-edge bg-panel shadow-[0_-12px_32px_-8px_rgb(0_0_0/0.9)]"
      data-testid="autocomplete"
    >
      {loading && items.length === 0 ? (
        // '없음'이 아니라 '아직'이다 — 세션이 막 떴을 때 스킬이 없는 것처럼 보이면 안 된다
        <p className="px-2.5 py-2 text-[11px] text-slate" data-testid="autocomplete-loading">
          {kind === 'command' ? 'Loading skills…' : 'Searching…'}
        </p>
      ) : (
        <ul ref={listRef} className="max-h-56 overflow-y-auto">
          {items.map((item, i) => (
            <li key={item.value}>
              <button
                type="button"
                data-idx={i}
                data-testid={`autocomplete-item-${i}`}
                aria-selected={i === index}
                // 마우스로 누를 때 입력창이 포커스를 잃으면 커서 위치가 사라진다
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(item)}
                className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors ${
                  i === index ? 'bg-graphite/50 text-chalk' : 'text-ash hover:bg-graphite/25'
                }`}
              >
                <span className="shrink-0 truncate text-[12px]">{item.label}</span>
                {item.hint && (
                  <span className="readout ml-auto truncate text-[10px] text-slate">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
