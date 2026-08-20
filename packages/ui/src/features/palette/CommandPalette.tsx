import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nextWaitingSession } from '@cc/core'
import { useStore } from '../../store/store.js'
import { computeInbox } from '../../store/selectors.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { Kbd } from '../../components/primitives.jsx'

type Item =
  | { kind: 'session'; id: string; label: string; sub: string }
  | { kind: 'project'; id: string; label: string; sub: string }
  | { kind: 'action'; id: string; label: string; sub: string; run: () => void }
  | { kind: 'message'; id: string; sessionId: string; label: string; sub: string }

/**
 * 커맨드 팔레트 (E-2) — 프로젝트·세션·동작·**대화 내용**을 한 입력창에서 찾는다.
 * "그거 어디서 얘기했지"가 이 앱의 실제 질문이라, 검색 결과를 같은 목록에 섞는다.
 */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  const toggle = useStore((s) => s.togglePalette)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const focusSession = useStore((s) => s.focusSession)
  const openGit = useStore((s) => s.openGit)
  const togglePanel = useStore((s) => s.togglePanel)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const toggleInbox = useStore((s) => s.toggleInbox)
  const platform = usePlatform()

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [hits, setHits] = useState<{ sessionId: string; seq: number; snippet: string }[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // 대화 내용 검색은 host에 묻는다 (SQLite FTS)
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setHits([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void platform.search
        .messages(query.trim(), 20)
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]))
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, query, platform])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)

    const actions: Item[] = [
      { kind: 'action', id: 'settings', label: 'Open settings', // The window's own categories, in its own order — the palette should not describe a
      // room by a floor plan it no longer has (issue #7)
      sub: 'Notifications · permissions · shortcuts', run: () => toggleSettings(true) },
      { kind: 'action', id: 'open-git', label: 'Open Git', sub: 'Changes · history · branches', run: () => openGit() },
      { kind: 'action', id: 'toggle-panel', label: 'Evidence panel', sub: '⌘B · Git · files', run: () => togglePanel() },
      /*
        The two waiting-list shortcuts are here because they stopped being printed on the
        top bar (issue #33). The bar advertised them next to the count, which is the one
        moment the count itself is what you want to read — and a hint you have already
        learned keeps charging you attention forever. Somewhere they can be found is still
        owed, though, so they are said twice: named with their keys in Settings → Shortcuts
        (for looking up), and runnable from here (for doing without knowing the key).
      */
      { kind: 'action', id: 'waiting', label: 'Waiting list', sub: '⌘I · everything waiting on you', run: () => toggleInbox(true) },
      {
        kind: 'action',
        id: 'next-waiting',
        label: 'Jump to next waiting',
        sub: '⌘⇧A · approvals first',
        run: () => {
          // 정렬은 core가 안다 (승인 → 오류 → 응답대기) — App의 전역 단축키와 같은 길이다
          const st = useStore.getState()
          const next = nextWaitingSession(computeInbox(st), st.focusedSessionId)
          if (next) focusSession(next)
        },
      },
    ]

    return [
      ...Object.values(sessions)
        .filter((s) => !s.archived && match(s.name))
        .slice(0, 8)
        .map<Item>((s) => ({
          kind: 'session',
          id: s.id,
          label: s.name,
          sub: (s.projectId ? projects[s.projectId]?.name : 'Orchestrator') ?? '',
        })),
      ...Object.values(projects)
        .filter((p) => match(p.name))
        .slice(0, 5)
        .map<Item>((p) => ({ kind: 'project', id: p.id, label: p.name, sub: p.path })),
      ...actions.filter((a) => match(a.label)),
      ...hits.slice(0, 10).map<Item>((h) => ({
        kind: 'message',
        id: `${h.sessionId}-${h.seq}`,
        sessionId: h.sessionId,
        label: h.snippet.trim().slice(0, 80),
        sub: sessions[h.sessionId]?.name ?? 'Chat',
      })),
    ]
  }, [query, sessions, projects, hits, openGit, togglePanel, toggleSettings, toggleInbox, focusSession])

  const choose = useCallback(
    (item: Item) => {
      if (item.kind === 'session' || item.kind === 'message') {
        focusSession(item.kind === 'session' ? item.id : item.sessionId)
      } else if (item.kind === 'project') {
        const first = Object.values(sessions).find((s) => s.projectId === item.id && !s.archived)
        if (first) focusSession(first.id)
      } else item.run()
      toggle(false)
    },
    [focusSession, sessions, toggle],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, items.length - 1))
      else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === 'Enter') {
        const item = items[cursor]
        if (item) choose(item)
      } else if (e.key === 'Escape') toggle(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, choose, toggle])

  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-40 flex items-start justify-center bg-void/80 pt-[14vh] backdrop-blur-[2px]"
      onClick={() => toggle(false)}
      data-testid="command-palette"
    >
      <div
        className="w-[600px] max-w-[92vw] overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-[13px] text-chalk placeholder:text-slate focus:outline-none"
          placeholder="Search sessions, projects, messages"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          data-testid="palette-input"
        />
        <ul className="max-h-[50vh] overflow-y-auto">
          {items.length === 0 ? (
            <li className="px-4 py-6 text-center text-[12px] text-slate" data-testid="palette-empty">
              No results
            </li>
          ) : (
            items.map((item, i) => (
              <li key={`${item.kind}-${item.id}`}>
                <button
                  className={`flex w-full items-baseline gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
                    i === cursor ? 'border-l-ash bg-graphite/40' : 'border-l-transparent hover:bg-graphite/20'
                  }`}
                  onClick={() => choose(item)}
                  data-testid={`palette-item-${item.kind}`}
                >
                  <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-slate">
                    {item.kind === 'session' ? 'Session' : item.kind === 'project' ? 'Folder' : item.kind === 'message' ? 'Chat' : 'Action'}
                  </span>
                  <span className="truncate text-[13px] text-chalk">{item.label}</span>
                  <span className="ml-auto shrink-0 truncate text-[11px] text-slate">{item.sub}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <footer className="flex items-center gap-1 border-t border-edge px-3 py-1.5 text-[10px] text-slate">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> Move
          <Kbd>↵</Kbd> Open
          <Kbd>esc</Kbd> Close
        </footer>
      </div>
    </div>
  )
}
