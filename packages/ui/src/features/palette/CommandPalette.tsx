import { usePresence } from '../../components/presence.js'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { nextWaitingSession } from '@cc/core'
import { newSessionProjectOf, useStore } from '../../store/store.js'
import { isRemoteUserApp, useAppCatalog } from '../../store/app-catalog.js'
import { computeInbox, currentWaitingId, projectLabelOf } from '../../store/selectors.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useNavShortcut, useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { Badge } from '../../components/Badge.jsx'
import { useFocusReturn } from '../../components/focusReturn.js'
import { useDialogFocus } from '../../components/dialogFocus.js'
import { composingKey } from '../../app/keys.js'
import { enterMayOpen, hitsAnswer, NO_HITS, type FoundHits } from './searchHits.js'

type Item =
  | { kind: 'session'; id: string; label: string; sub: string }
  | { kind: 'project'; id: string; label: string; sub: string }
  | { kind: 'action'; id: string; label: string; sub: string; run: () => void }
  | { kind: 'message'; id: string; sessionId: string; seq: number; label: string; sub: string }
  | { kind: 'app'; id: string; label: string; sub: string; projectId: string | null; appId: string; machine: string | null }

/**
 * Command palette (E-2) — finds projects, sessions, apps, actions and **conversation content** from
 * one search box. Since "where did we talk about that" is the real question in this app, search
 * results are mixed into the same list. Opened by ⌘K / Ctrl+K, or by the search field in the top bar
 * (#529, #727), which is how a person who was never told the key finds it.
 */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen)
  // Esc gives the keyboard back to where it was, the composer included (#115)
  const toggle = useStore((s) => s.togglePalette)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const focusSession = useStore((s) => s.focusSession)
  const openSearchHit = useStore((s) => s.openSearchHit)
  const focusProject = useStore((s) => s.focusProject)
  const askComposerFocus = useStore((s) => s.askComposerFocus)
  const openGit = useStore((s) => s.openGit)
  const togglePanel = useStore((s) => s.togglePanel)
  const toggleSettings = useStore((s) => s.toggleSettings)
  const toggleInbox = useStore((s) => s.toggleInbox)
  const openNewSession = useStore((s) => s.openNewSession)
  const openApp = useStore((s) => s.openApp)
  const machines = useStore((s) => s.machines)
  // Where "New session" would start one: named in its row, so the person sees which project before choosing it
  const newSessionIn = useStore((s) => newSessionProjectOf(s))
  const catalog = useAppCatalog()
  const platform = usePlatform()
  const sc = useShortcut()
  const nav = useNavShortcut()

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  // The hits with the query they answer: until the answer to the latest keystroke comes, the rows are an earlier query's
  const [found, setFound] = useState<FoundHits<{ sessionId: string; seq: number; snippet: string }>>(NO_HITS)
  const hits = found.list
  const hitsFresh = hitsAnswer(found, query)
  const inputRef = useRef<HTMLInputElement>(null)

  // Searching conversation content asks the host (SQLite FTS)
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setFound(NO_HITS)
      return
    }
    let alive = true
    const asked = query.trim()
    const t = setTimeout(() => {
      void platform.search
        .messages(asked, 20)
        .then((r) => alive && setFound({ query: asked, list: r }))
        .catch(() => alive && setFound({ query: asked, list: [] }))
    }, 150)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, query, platform])

  /**
   * Clearing happens **on close**, not on open.
   *
   * This effect runs **after** the render where `open` became true. But the input box is already
   * on screen in that same render — anything typed in between gets wiped out by this effect.
   * Someone who starts typing the instant they press ⌘K loses their first character, and this
   * happens more often the slower the machine is (the wider that gap gets). It showed up
   * intermittently when the full e2e suite ran in parallel: the palette stayed open with the
   * filter cleared, leaving all 5 items still listed.
   *
   * Clearing on close means it is already empty the next time it opens, and the write that
   * overwrites input after the render disappears entirely. What the person sees behaves
   * identically.
   */
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0)
      return
    }
    setQuery('')
    setCursor(0)
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)

    const newIn = newSessionIn ? projects[newSessionIn] : undefined
    const actions: Item[] = [
      // Starting a session (#529): the dialog the project's + opens, for the project the person is in
      ...(newIn
        ? [{ kind: 'action' as const, id: 'new-session', label: 'New session', sub: `in ${newIn.name}`, run: () => openNewSession(newIn.id) }]
        : []),
      { kind: 'action', id: 'settings', label: 'Open settings', // The window's own categories, in its own order — the palette should not describe a
      // room by a floor plan it no longer has (issue #7)
      sub: 'Notifications · permissions · shortcuts', run: () => toggleSettings(true) },
      { kind: 'action', id: 'open-git', label: 'Open Git', sub: 'Changes · history · branches', run: () => openGit() },
      // Import (#1141): its sidebar door went with "Your apps"; an imported app lands as a project of its own
      { kind: 'action', id: 'import-app', label: 'Import an app', sub: 'From a folder, a .zip or a link', run: () => useStore.getState().openImport() },
      { kind: 'action', id: 'toggle-panel', label: 'Evidence panel', sub: `${sc('mod', 'B')} · changes · files`, run: () => togglePanel() },
      /*
        The two waiting-list shortcuts are here because they stopped being printed on the
        top bar (issue #33). The bar advertised them next to the count, which is the one
        moment the count itself is what you want to read — and a hint you have already
        learned keeps charging you attention forever. Somewhere they can be found is still
        owed, though, so they are said twice: named with their keys in Settings → Shortcuts
        (for looking up), and runnable from here (for doing without knowing the key).
      */
      // Back and forward between screens (#374). The palette lays over the screen and is not one, so back goes to the screen before the one under it
      { kind: 'action', id: 'nav-back', label: 'Go back', sub: `${nav(-1)} · the screen before`, run: () => useStore.getState().goBack() },
      { kind: 'action', id: 'nav-forward', label: 'Go forward', sub: `${nav(1)} · the screen after`, run: () => useStore.getState().goForward() },
      { kind: 'action', id: 'waiting', label: 'Waiting list', sub: `${sc('mod', 'I')} · everything waiting on you`, run: () => toggleInbox(true) },
      {
        kind: 'action',
        id: 'next-waiting',
        label: 'Jump to next waiting',
        sub: `${sc('mod', '⇧A')} · approvals first`,
        run: () => {
          // The ordering (approval → error → waiting for input) is known by core — the same path as App's global shortcut
          const st = useStore.getState()
          const next = nextWaitingSession(computeInbox(st), currentWaitingId(st))
          if (next) st.openWaiting(next)
        },
      },
    ]

    return [
      ...Object.values(sessions)
        .filter((s) => match(s.name))
        .slice(0, 8)
        .map<Item>((s) => ({
          kind: 'session',
          id: s.id,
          label: s.name,
          sub: projectLabelOf(projects, s.projectId),
        })),
      ...Object.values(projects)
        .filter((p) => match(p.name))
        .slice(0, 5)
        .map<Item>((p) => ({ kind: 'project', id: p.id, label: p.name, sub: p.path })),
      /*
       * Apps (#529), by name — the same rows the sidebar lists, so an app scrolled out of sight or on a folded project
       * is a few letters away. Only when asked for: with nothing typed, the list stays the sessions and projects it was.
       */
      ...(q
        ? catalog.external
            .filter((a) => match(a.title))
            .slice(0, 5)
            .map<Item>((a) => {
              const machine = isRemoteUserApp(a.info) ? (a.info.machine ?? null) : null
              const sub = a.projectId
                ? (projects[a.projectId]?.name ?? '')
                : machine
                  ? (machines[machine]?.name ?? machine)
                  : 'Other apps'
              return { kind: 'app', id: a.key, label: a.title, sub, projectId: a.projectId, appId: a.appId, machine }
            })
        : []),
      ...actions.filter((a) => match(a.label)),
      ...hits.slice(0, 10).map<Item>((h) => ({
        kind: 'message',
        id: `${h.sessionId}-${h.seq}`,
        sessionId: h.sessionId,
        seq: h.seq,
        label: h.snippet.trim().slice(0, 80),
        sub: sessions[h.sessionId]?.name ?? 'Chat',
      })),
    ]
  }, [
    query,
    sessions,
    projects,
    hits,
    catalog,
    machines,
    newSessionIn,
    openNewSession,
    openGit,
    togglePanel,
    toggleSettings,
    toggleInbox,
    sc,
    nav,
  ])

  const choose = useCallback(
    (item: Item) => {
      /*
       * A session picked here is one the person is going to type to (#528): its composer takes the
       * keyboard once the palette is gone. The palette's own field leaves with it and drops focus on
       * the page, where no key reaches the composer (a Tab did in WebKit on macOS only).
       */
      const go = (id: string) => {
        focusSession(id)
        askComposerFocus(id)
      }
      if (item.kind === 'session') {
        go(item.id)
      } else if (item.kind === 'message') {
        openSearchHit(item.sessionId, item.seq)
      } else if (item.kind === 'project') {
        const first = Object.values(sessions).find((s) => s.projectId === item.id)
        // A project with no session still has to be selectable (#183) — it used to just close the palette and leave the screen unchanged
        if (first) go(first.id)
        else focusProject(item.id)
      } else if (item.kind === 'app') {
        // As its sidebar row opens it: only a linked machine's user-folder app names its machine (AppRow)
        openApp(item.projectId, item.appId, { machine: item.machine })
      } else item.run()
      toggle(false)
    },
    [focusSession, focusProject, askComposerFocus, openSearchHit, openApp, sessions, toggle],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      /*
       * While a word is being composed (Korean, Japanese, Chinese), these keys are the input
       * method's: Enter finishes the syllable, the arrows walk its candidates, Esc cancels it
       * (#181). Taking that Enter ran the highlighted command the moment the person finished
       * typing "설정", and closed the palette under the input method.
       */
      if (composingKey(e)) return
      if (e.key === 'ArrowDown') setCursor((c) => Math.min(c + 1, items.length - 1))
      else if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === 'Enter') {
        const item = items[cursor]
        // A hit from the query before this one is not opened: its answer is on its way and replaces the rows
        if (item && enterMayOpen(item, hitsFresh)) choose(item)
      } else if (e.key === 'Escape') toggle(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, choose, toggle, hitsFresh])

  /*
   * A dialog with a combobox (#842 item 7): focus stays inside while it is up, the field says it drives the list, and the
   * list says which option the cursor is on. The options are not Tab stops: the arrows walk them, as the footer says.
   */
  const panelRef = useRef<HTMLDivElement>(null)
  // Leaves with its exit (usePresence below), so focus inside it is given back as it closes (#115)
  useFocusReturn(open, panelRef)
  const dialog = useDialogFocus(panelRef, open)
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`

  // Comes down from the field and fades in, and goes the same way (usePresence keeps it for its exit)
  const { shown, leaving } = usePresence(open)
  if (!shown) return null

  /*
   * A popover hanging from the top bar's search field (#727), not a dialog in the middle of the
   * window. The catcher covers the whole window, the top bar included, so a press anywhere but the
   * panel closes it, as it did; only the dimming starts below the bar (top-9 is the bar's h-9,
   * App's TopBar), so the field the person pressed stays in view over the panel that came from it.
   * The catcher sits outside the bar's drag region in the tree, so a press on it never moves the
   * window. The panel is centred in the window like the field, and opens at the bar's edge.
   */
  return (
    <div
      className={`absolute inset-0 z-40 flex items-start justify-center pt-10 ${leaving ? 'pointer-events-none' : ''}`}
      onClick={() => toggle(false)}
      data-testid="command-palette"
      data-leaving={leaving || undefined}
      // Leaving, it takes no keys and no focus: a layer closing over it gives focus back past it (focusReturn.ts)
      inert={leaving}
    >
      <div className={`absolute inset-x-0 bottom-0 top-9 bg-scrim backdrop-blur-[2px] ${leaving ? 'cc-fade-out' : 'cc-fade'}`} />
      <div
        ref={panelRef}
        {...dialog}
        aria-label="Command palette"
        className={`relative w-[600px] max-w-[calc(92vw/var(--text-zoom))] overflow-hidden rounded-lg border border-line bg-surface-side shadow-(--shadow-modal) outline-none ${
          leaving ? 'cc-drop-out' : 'cc-drop'
        }`}
        onClick={(e) => e.stopPropagation()}
        data-testid="palette-panel"
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items[cursor] ? optionId(cursor) : undefined}
          aria-label="Search sessions, projects, apps, messages"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-md text-ink placeholder:text-ink-faint focus:outline-none"
          placeholder="Search sessions, projects, apps, messages"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          data-testid="palette-input"
        />
        <ul id={listId} role="listbox" aria-label="Results" className="max-h-[calc(50vh/var(--text-zoom))] overflow-y-auto">
          {items.length === 0 ? (
            <li role="presentation" className="px-4 py-6 text-center text-sm text-ink-faint" data-testid="palette-empty">
              No results
            </li>
          ) : (
            items.map((item, i) => (
              <li key={`${item.kind}-${item.id}`} role="presentation">
                <button
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === cursor}
                  tabIndex={-1}
                  className={`flex w-full items-baseline gap-2 border-l-2 px-3 py-1.5 text-left transition-colors ${
                    i === cursor ? 'border-l-ink-muted bg-surface-hover/40' : 'border-l-transparent hover:bg-surface-hover/20'
                  }`}
                  onClick={() => choose(item)}
                  data-testid={`palette-item-${item.kind}`}
                >
                  <Badge className="w-10 shrink-0">
                    {item.kind === 'session'
                      ? 'Session'
                      : item.kind === 'project'
                        ? 'Folder'
                        : item.kind === 'message'
                          ? 'Chat'
                          : item.kind === 'app'
                            ? 'App'
                            : 'Action'}
                  </Badge>
                  <span className="truncate text-md text-ink">{item.label}</span>
                  <span className="ml-auto shrink-0 truncate text-xs text-ink-faint">{item.sub}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <footer className="flex items-center gap-1 border-t border-line px-3 py-1.5 text-2xs text-ink-faint">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> Move
          <Kbd>↵</Kbd> Open
          <Kbd>esc</Kbd> Close
        </footer>
      </div>
    </div>
  )
}
