import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandInfo } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { loadErrorText, useLoad } from '../../app/useLoad.js'
import { useStore } from '../../store/store.js'
import { filesView, skillsView, type FileAnswer, type Skills } from './autocompleteState.js'
import { GUI_COMMANDS } from './guiCommands.js'

/**
 * Composer autocomplete — `/` for skills, `@` for files.
 *
 * The UI does not need to know the lists come from different places:
 *   skills come from each tool's official API (Claude's supportedCommands, Codex's
 *   skills/list), files are found by the host in the project index.
 *
 * Two things are held to:
 *  1. **Never block typing.** Even if the list cannot be fetched, typing and sending still work.
 *  2. **Distinguish "none" from "not yet".** Right after a session is created, the tool is still
 *     starting up and cannot be asked for skills — showing an empty list at that moment makes
 *     it look as though there are no skills.
 */

export type Suggestion = { value: string; label: string; hint: string }

/**
 * A **fixed** empty map to return when not subscribed — a fresh object every time would defeat
 * both memo and the selector
 */
const EMPTY_MAP: Record<string, never> = {}

/**
 * Score for a slash command. Higher ranks first. null drops it from the list.
 *
 * The rules come from how people actually type:
 *  - Having typed `usage` in full means the person is looking for `usage`, not
 *    `usage-credit` → **an exact match ranks highest**
 *  - Typing the leading letters means recalling the **start** of the name → matches starting
 *    from the front rank above others
 *  - With only one or two letters typed, letting a match in the middle of a name interrupt
 *    makes the list useless (e.g. typing `u` alone surfacing `docs-lookup`) → short queries
 *    only get start or word-boundary matches
 */
export function scoreCommand(name: string, query: string): number | null {
  const n = name.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 100 - Math.min(n.length, 40)

  if (n === q) return 1000
  if (n.startsWith(q)) return 800 - Math.min(n.length - q.length, 60)

  // What follows a `-`, `:` or `_` also counts as the start of a name (credit in usage-credit)
  const boundary = n.split(/[-:_/]/).some((part) => part.startsWith(q))
  if (boundary) return 500 - Math.min(n.length, 60)

  // A mid-word match on a short query is just noise
  if (q.length <= 2) return null
  return n.includes(q) ? 200 - Math.min(n.length, 60) : null
}

/** Works out the autocomplete target from the text before the caret */
export function detectTrigger(
  text: string,
  caret: number,
): { kind: 'command' | 'file'; query: string; start: number } | null {
  const before = text.slice(0, caret)

  // A slash command can **only start at the very beginning** — a path in the middle of a
  // sentence (`src/a.ts`) must not be read as a command
  const slash = /^\/([\w:-]*)$/.exec(before)
  if (slash) return { kind: 'command', query: slash[1] ?? '', start: 0 }

  // @ can start anywhere, but only right after whitespace (or at the very start) — this avoids
  // matching email addresses
  const at = /(^|\s)@([^\s]*)$/.exec(before)
  if (at) return { kind: 'file', query: at[2] ?? '', start: caret - (at[2] ?? '').length - 1 }

  return null
}

/**
 * How long Enter and Tab wait for the file search of the latest keystroke before the list gives up on it (#842 review
 * of item 13). The host answers from an index in milliseconds; this only bounds a search that hangs, so the composer
 * can still send.
 */
export const FILE_SEARCH_WAIT_MS = 1500

/** Which search a file result answers: the project and the query */
function searchKey(projectId: string, query: string): string {
  return `${projectId}\n${query}`
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
   * What `@` points to.
   *
   * Files mean nothing to the orchestrator — it has no hands, so it does not touch files.
   * Instead `@` picks a **session**: naming one by voice can point at the wrong name, and if
   * work goes to the wrong session, that project is actually changed.
   */
  atSource?: 'files' | 'sessions'
}) {
  const platform = usePlatform()
  /** The search that took too long to wait for (`FILE_SEARCH_WAIT_MS`): its key, so the next keystroke waits again */
  const [gaveUp, setGaveUp] = useState<string | null>(null)
  const [index, setIndex] = useState(0)

  const trigger = useMemo(() => (enabled ? detectTrigger(text, caret) : null), [enabled, text, caret])

  /*
   * The session list already lives in the store — the orchestrator's `@` picks from it here.
   *
   * **Only subscribed while `@` is being typed.** `s.sessions` is a map that becomes an
   * entirely new object even if a single session so much as breathes, so subscribing to it
   * unconditionally made this hook re-run on every delta while a response streamed, and the
   * composer using it re-rendered right along with it (measured: 2.0 renders per character
   * while streaming). The one moment this value is actually needed is the few seconds the menu
   * is open.
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
  const wantCommands = trigger?.kind === 'command'
  /*
   * The session the list was first wanted for. Once asked it stays asked while the `/` comes and goes, so the list
   * does not blink back to "Loading skills…" on every `/`; a session of its own (the focus view's pane swaps sessions
   * without a key change) asks again, and so does a `/` typed after an answer that gave no list.
   */
  const [askedFor, setAskedFor] = useState<string | null>(null)
  if (wantCommands && askedFor !== sessionId) setAskedFor(sessionId)
  const skills = useLoad<Skills>(
    () => (askedFor === sessionId ? platform.agents.commands(sessionId).then((r) => ({ sessionId, ...r })) : null),
    [askedFor, sessionId, platform],
    // The session came alive: a cached answer is what was true last time, so ask the tool itself (above)
    [live],
  )
  const skillsNow = skillsView(sessionId, skills)
  const skillsWait = skillsNow.loading || skillsNow.note !== null
  useEffect(() => {
    if (!wantCommands && skillsWait && askedFor !== null) setAskedFor(null)
  }, [wantCommands, skillsWait, askedFor])

  // Files are searched on every keystroke (fast, since the host holds the index)
  const fileQuery = trigger?.kind === 'file' && atSource === 'files' ? trigger.query : null
  const fileKey = fileQuery !== null ? searchKey(projectId, fileQuery) : null
  /*
   * Each answer carries the search it answers (#842 item 13): after a keystroke the list still held the previous
   * query's results until the new answer came, and Enter or Tab in that moment inserted one of them (after a switch of
   * session, even a path from the previous project). A failed search is an answer too, with its reason: it is not "no
   * files" (#1143 U14), and a later query is not known to find nothing either.
   */
  // The search on screen, for the read below: a new keystroke is a refresh of the same subject (the project), not a new one
  const wanted = useRef({ fileKey, fileQuery })
  wanted.current = { fileKey, fileQuery }
  const found = useLoad<FileAnswer>(
    () => {
      const { fileKey: key, fileQuery: query } = wanted.current
      if (key === null || query === null) return null
      return platform.fs.search(projectId, query, 20).then(
        (list) => ({ key, projectId, query, list, error: null }),
        (e: unknown) => ({ key, projectId, query, list: [], error: loadErrorText(e) }),
      )
    },
    [platform, projectId],
    [fileKey],
  )
  useEffect(() => {
    if (fileKey === null) return
    // A search that hangs must not hold the composer: past this the list stops waiting for it (#842 review of item 13)
    const t = setTimeout(() => setGaveUp(fileKey), FILE_SEARCH_WAIT_MS)
    return () => clearTimeout(t)
  }, [fileKey])
  const filesNow = filesView({ fileKey, projectId, query: fileQuery, answer: found.data, gaveUp })
  const filesStale = filesNow.stale

  const items = useMemo<Suggestion[]>(() => {
    if (!trigger) return []
    if (trigger.kind === 'command') {
      /*
       * Never truncated. This used to keep only the top 20, but since the empty-query sort
       * ranks short names first, a plugin's longer-named skills (all twenty-one of
       * openai-templates:*) were **entirely** cut off — on screen that just looked like they
       * did not exist, and it was reported exactly that way. The list already scrolls
       * (max-h-56), so nothing is lost by being long, and the measured maximum of 102 entries
       * is not a size that needs virtual scrolling.
       */
      /*
       * GUI commands (usage, etc.) stand in the same list — picking one opens an app screen
       * instead of sending a message (guiCommands.ts). These show up immediately even while
       * the session command list is still loading.
       */
      const scored: { name: string; s: number; item: Suggestion }[] = [
        ...GUI_COMMANDS.map((g) => ({
          g,
          s: scoreCommand(g.name, trigger.query),
        }))
          .filter((x): x is { g: (typeof GUI_COMMANDS)[number]; s: number } => x.s !== null)
          .map(({ g, s }) => ({
            name: g.name,
            s,
            item: {
              value: `/${g.name}`,
              label: `/${g.name}`,
              hint: `${g.description} — opens in app`,
            },
          })),
        ...skillsNow.commands
          .map((c) => ({ c, s: scoreCommand(c.name, trigger.query) }))
          .filter((x): x is { c: CommandInfo; s: number } => x.s !== null)
          .map(({ c, s }) => ({
            name: c.name,
            s,
            item: {
              value: `/${c.name} `,
              label: `/${c.name}`,
              hint: c.argumentHint || c.description,
            },
          })),
      ]
      return (
        scored
          // On a tied score, the shorter name ranks first — that is usually the one being
          // looked for
          .sort((a, b) => (b.s === a.s ? a.name.length - b.name.length : b.s - a.s))
          .map((x) => x.item)
      )
    }
    if (atSource === 'sessions') {
      const q = trigger.query.toLowerCase()
      return sessions
        .filter((x) => x.projectId !== null && x.name.toLowerCase().includes(q))
        .slice(0, 20)
        .map((x) => ({ value: `@${x.name} `, label: x.name, hint: projectNames[x.projectId!] ?? '' }))
    }
    return filesNow.list.map((f) => ({ value: `@${f.path} `, label: f.name, hint: f.path }))
  }, [trigger, skillsNow.commands, filesNow.list, atSource, sessions, projectNames])

  // Reset to the first item whenever the list changes — a stale cursor position picks the
  // wrong one
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

  const loading = (trigger?.kind === 'command' && skillsNow.loading) || filesStale
  // Why a list is not there, said once nothing is on its way: a failed read is not an empty list (#1143 U13, U14)
  const note = trigger?.kind === 'command' ? skillsNow.note : filesNow.note

  return {
    open: !!trigger && (items.length > 0 || loading || note !== null),
    note,
    kind: trigger?.kind ?? null,
    items,
    index,
    loading,
    /** The list answers an earlier search: Enter and Tab wait for the answer instead of picking (#842 item 13) */
    stale: filesStale,
    move: (delta: number) =>
      setIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length)),
    apply,
  }
}

/** The id of an option in the list `listId` names, which the composer points at as the active one (#842 item 7) */
export function suggestionId(listId: string, index: number): string {
  return `${listId}-${index}`
}

export function AutocompleteMenu({
  listId,
  items,
  index,
  loading,
  note = null,
  kind,
  onPick,
}: {
  /** The list's id: the composer names it as what it controls */
  listId: string
  items: Suggestion[]
  index: number
  loading: boolean
  /** Why the list is not there (it could not be read), when nothing is on its way */
  note?: string | null
  kind: 'command' | 'file' | null
  onPick: (item: Suggestion) => void
}) {
  const listRef = useRef<HTMLUListElement>(null)

  // Follows along when moving with the keyboard, so the selection never scrolls off screen
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  return (
    <div
      className="absolute bottom-full left-0 z-30 mb-1 w-full overflow-hidden rounded-md border border-line bg-surface-raised shadow-(--shadow-popover-up)"
      data-testid="autocomplete"
    >
      {loading && items.length === 0 ? (
        // This is "not yet", not "none" — right after a session starts, it must not look as
        // though it has no skills
        <p className="px-2.5 py-2 text-xs text-ink-faint" data-testid="autocomplete-loading">
          {kind === 'command' ? 'Loading skills…' : 'Searching…'}
        </p>
      ) : (
        <ul ref={listRef} id={listId} role="listbox" aria-label={kind === 'command' ? 'Commands' : 'Suggestions'} className="max-h-56 overflow-y-auto">
          {items.map((item, i) => (
            <li key={item.value} role="presentation">
              <button
                type="button"
                id={suggestionId(listId, i)}
                role="option"
                tabIndex={-1}
                data-idx={i}
                data-testid={`autocomplete-item-${i}`}
                aria-selected={i === index}
                // If the composer loses focus on a mouse press, the caret position is lost
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(item)}
                className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors ${
                  i === index ? 'bg-surface-hover/50 text-ink' : 'text-ink-muted hover:bg-surface-hover/25'
                }`}
              >
                <span className="shrink-0 truncate text-sm">{item.label}</span>
                {item.hint && (
                  <span className="readout ml-auto truncate text-2xs text-ink-faint">{item.hint}</span>
                )}
              </button>
            </li>
          ))}
          {/* GUI commands can already be listed while skills are still not yet — "not yet"
          speaks up below the list too */}
          {loading && (
            <li role="presentation">
              <p
                className="border-t border-line px-2.5 py-1.5 text-xs text-ink-faint"
                data-testid="autocomplete-loading"
              >
                {kind === 'command' ? 'Loading skills…' : 'Searching…'}
              </p>
            </li>
          )}
          {/* A list that could not be read says so, in the place "Loading" stood: it is not an empty list (#1143) */}
          {!loading && note && (
            <li role="presentation">
              <p
                className={`px-2.5 py-1.5 text-xs text-ink-faint ${items.length > 0 ? 'border-t border-line' : ''}`}
                data-testid="autocomplete-note"
              >
                {note}
              </p>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
