import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'

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
}: {
  sessionId: string
  projectId: string
  text: string
  caret: number
  enabled: boolean
}) {
  const platform = usePlatform()
  const [commands, setCommands] = useState<{ ready: boolean; commands: CommandInfo[] }>({
    ready: false,
    commands: [],
  })
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const [index, setIndex] = useState(0)

  const trigger = useMemo(() => (enabled ? detectTrigger(text, caret) : null), [enabled, text, caret])

  // 스킬은 세션이 준비된 뒤에야 물어볼 수 있다. 한 번 받아두면 계속 쓴다
  useEffect(() => {
    if (trigger?.kind !== 'command' || commands.ready) return
    let alive = true
    void platform.agents
      .commands(sessionId)
      .then((r) => alive && setCommands(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [trigger?.kind, commands.ready, platform, sessionId])

  // 파일은 칠 때마다 찾는다 (host가 색인을 들고 있어 빠르다)
  useEffect(() => {
    if (trigger?.kind !== 'file') return
    let alive = true
    void platform.fs
      .search(projectId, trigger.query, 20)
      .then((r) => alive && setFiles(r))
      .catch(() => alive && setFiles([]))
    return () => {
      alive = false
    }
  }, [trigger?.kind, trigger?.query, platform, projectId])

  const items = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    if (trigger.kind === 'command') {
      const q = trigger.query.toLowerCase()
      return commands.commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, hint: c.argumentHint || c.description }))
    }
    return files.map((f) => ({ value: `@${f.path} `, label: f.name, hint: f.path }))
  }, [trigger, commands, files])

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
    move: (delta: number) => setIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length)),
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
          {kind === 'command' ? '스킬을 불러오는 중…' : '찾는 중…'}
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
