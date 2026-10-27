import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SavedCommand } from '@cc/protocol/client'
import {
  ChevronIcon,
  CloseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RestartIcon,
  RingIcon,
  StopIcon,
} from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Button } from '../../components/Button.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { Kbd } from '../../components/primitives.jsx'
import { RelativeAge } from '../../components/RelativeAge.jsx'
import { useOpenLayer } from '../../components/Modal.jsx'
import { isPlainEnter, isPlainEscape, isTextEntry } from '../../app/keys.js'
import { useLabelNow } from '../../app/useLabelNow.js'
import { CommandLogView } from '../../components/CommandLogView.jsx'
import { usePresence } from '../../components/presence.js'
import { useStore, type ChatItem, type CommandRun } from '../../store/store.js'
import { formatElapsed, nextElapsedTick } from './elapsed.js'

/*
 * Saved commands, redrawn from what a person does with them (owner, 2026-10-19: "tear it down, make it a better UX").
 *
 * - The common act is "start the dev server" or "run the tests", so each row carries its own Run (Stop while it runs)
 *   at its start: one click, no picking first. The old pick-then-Run took two clicks and a look at a second place.
 * - Each row says how it stands, so the list answers "what is running and how did the last run end" at a glance: a
 *   breathing dot and the time it has been running, or how it ended and how long ago. Running is the plain ink, not
 *   white (nothing waits on the person); a failed run is the dashed grey ring, "failed, nothing waits".
 * - The log opens in place under its row (a click on the row, or Space), one at a time, so the window stays a short
 *   list until a log is asked for. A running command's log also stands in the evidence panel's terminal tab, as
 *   before; this window keeps the last log after it ends.
 * - Restart stands beside a running row; rename and remove come up on hover or focus, remove at the far end, away from
 *   Run, since a removal cannot be undone.
 * - Adding is command first; the name field shows up once there is a command to name. Commands the agent ran in this
 *   session are offered under the field, most repeated first, so a command just seen can be kept in one click.
 * - Keys from the header button: the list takes the keyboard, ↑↓ move, ↵ runs (on a running row it opens the log
 *   instead: Enter never stops or restarts a server), Space opens or closes the log, Esc closes.
 *
 * Kept from before: a saved command is its command string, and wherever a name is shown its command is shown with it
 * (2026-09-06); run state lives in the store's record (commandRuns), shared with the terminal tab and the header
 * button, so a run goes on with the window closed; only the last run's log per command is kept on the host and is
 * replaced when that command runs again (2026-08-26). It opens as a dropdown under the header's button and comes and
 * goes with `usePresence`, held by SessionView, so `leaving` is its exit.
 */

const NO_COMMANDS: SavedCommand[] = []
const NO_RUNS: Record<string, never> = {}
const NO_ITEMS: ChatItem[] = []
/** How many of the agent's commands are offered under the add field */
const SUGGESTIONS = 3

export function CommandRunnerOverlay({
  projectId,
  sessionId,
  leaving = false,
  onClose,
}: {
  projectId: string
  /** The session it was opened from: the agent's commands there are offered to save */
  sessionId?: string
  /** On its way out (usePresence in SessionView): plays the exit and takes no presses or keys */
  leaving?: boolean
  onClose: () => void
}) {
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const runCommand = useStore((s) => s.runCommand)
  const stopCommand = useStore((s) => s.stopCommand)
  const runs: Record<string, CommandRun> = useStore((s) => s.commandRuns[projectId] ?? NO_RUNS)
  const chat = useStore((s) => (sessionId ? s.chat[sessionId] : undefined) ?? NO_ITEMS)

  /** The row the keys are on */
  const [rawCursor, setCursor] = useState(0)
  const cursor = Math.min(rawCursor, Math.max(commands.length - 1, 0))
  /** The command whose log is open under its row (the command string is the key) */
  const [logOf, setLogOf] = useState<string | null>(null)
  /** The command whose name is being edited */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  const [adding, setAdding] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const addRef = useRef<HTMLInputElement>(null)
  // A layer that covers the pane — while it is open, the approval card underneath does not receive y/n/a (#158)
  useOpenLayer()

  // Reads the host's run record on open — a run keeps going with the window closed, so reopening picks it up.
  // (The grid has no evidence panel, so this has to be read here too, right after a UI reload)
  useEffect(() => {
    void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  // The keyboard comes here as the window opens: to the list, or to the add field when there is nothing to list yet
  const hasCommands = commands.length > 0
  useEffect(() => {
    if (hasCommands) listRef.current?.focus()
    else addRef.current?.focus()
    // Only as it opens: a list emptied while open does not pull the keyboard around
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const suggestions = useMemo(() => agentCommands(chat, commands), [chat, commands])

  // Running and stopping go through the store's record — the terminal tab and the header button see the same fact
  const run = useCallback((command: string) => void runCommand(projectId, command), [runCommand, projectId])
  const stop = (command: string) => void stopCommand(projectId, command)
  const toggleLog = useCallback(
    (command: string) => setLogOf((open) => (open === command ? null : command)),
    [],
  )

  useEffect(() => {
    // Leaving, it no longer answers keys: the Esc that closed it must not reach it twice
    if (leaving) return
    const onKey = (e: KeyboardEvent) => {
      if (isPlainEscape(e)) {
        e.stopPropagation()
        // While a name is edited, Esc cancels the edit — closing the window too would collapse both steps at once
        if (renaming !== null) setRenaming(null)
        else onClose()
        return
      }
      // Fields keep their keys (the add field's Enter adds, a rename's Enter saves), and so does anything outside this
      // window: in the grid, another pane's keys must not run this pane's commands
      const inside =
        e.target === document.body || (e.target instanceof Node && !!rootRef.current?.contains(e.target))
      if (!inside || isTextEntry(e.target) || commands.length === 0) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setCursor(Math.min(Math.max(cursor + step, 0), commands.length - 1))
        // The keys stay with the list, not a button Tab left focused, so ↵ means the row's run from here on
        listRef.current?.focus()
        return
      }
      // A focused button presses itself on Enter and Space
      if (e.target instanceof HTMLElement && e.target.closest('button')) return
      const c = commands[cursor]
      if (!c) return
      if (isPlainEnter(e)) {
        e.preventDefault()
        // Enter never stops or restarts a server: on a running row it shows the log instead
        if (runs[c.command]?.running) setLogOf(c.command)
        else run(c.command)
      } else if (e.key === ' ') {
        e.preventDefault()
        toggleLog(c.command)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, renaming, leaving, commands, cursor, runs, run, toggleLog])

  const add = (command: string, label = '') => {
    const clean = command.trim()
    if (!clean) return
    const name = label.trim()
    // The same command twice would be two rows sharing one run and one log: the row that is there is pointed at instead
    const at = commands.findIndex((c) => c.command === clean)
    setDraft('')
    setDraftName('')
    if (at >= 0) {
      setCursor(at)
      return
    }
    setCursor(commands.length)
    void save(projectId, [...commands, { command: clean, ...(name ? { label: name } : {}) }])
  }

  const rename = (command: string, label: string) => {
    setRenaming(null)
    const clean = label.trim()
    void save(
      projectId,
      commands.map((c) => (c.command === command ? { command, ...(clean ? { label: clean } : {}) } : c)),
    )
  }

  const remove = (i: number) => {
    const c = commands[i]
    if (c && logOf === c.command) setLogOf(null)
    void save(
      projectId,
      commands.filter((_, j) => j !== i),
    )
  }

  const showSuggestions = suggestions.length > 0 && !draft && (adding || commands.length === 0)

  return (
    /*
      Clicking the outer margin closes it — ignored if the window itself started the mousedown.
      It does not dim the pane: a dropdown does not take the screen away (the inbox's rule).
    */
    <div
      ref={rootRef}
      className={`absolute inset-0 z-40 flex items-start justify-end px-2 pb-4 pt-8 ${leaving ? 'pointer-events-none' : ''}`}
      data-testid="run-menu"
      inert={leaving}
      onMouseDown={(e) => {
        if (e.target === rootRef.current) onClose()
      }}
    >
      {/* A dropdown under the header's run button (2026-09-06): only as tall as its rows, and taller once a log opens */}
      <div
        role="dialog"
        aria-label="Commands"
        className={`flex max-h-full w-[min(520px,100%)] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-(--shadow-dropdown) ${
          leaving ? 'cc-drop-out' : 'cc-drop'
        }`}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line/60 py-2 pl-3 pr-2">
          <h2 className="text-sm font-medium text-ink">Commands</h2>
          {hasCommands && (
            /* Each key stays with its word, and the pairs stand apart, so a narrow window drops whole pairs at the end
               rather than squeezing a key into the next word (owner, 2026-10-19) */
            <span className="ml-auto flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap text-2xs text-ink-faint">
              <span className="flex shrink-0 items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <span>Move</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Kbd>↵</Kbd>
                <span>Run</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Kbd>space</Kbd>
                <span>Log</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <Kbd>esc</Kbd>
                <span>Close</span>
              </span>
            </span>
          )}
        </header>

        {/*
          The rows, drawn as a menu: no box per row (boxed rows on a slab read as a column of empty fields, 2026-09-07),
          rows rounded inside the list's inset, the menu's hover, and the row the keys are on on `surface-selected`.
        */}
        <ul
          ref={listRef}
          tabIndex={-1}
          aria-label="Saved commands"
          className="min-h-0 flex-1 overflow-y-auto p-1 focus:outline-none"
        >
          {commands.length === 0 && (
            <li className="px-2 py-4 text-center text-sm text-ink-muted" data-testid="run-empty">
              No saved commands
              <span className="mt-0.5 block text-xs text-ink-faint">
                {suggestions.length > 0
                  ? 'Add one below, or keep one the agent ran'
                  : 'Add one below to run it in the project folder'}
              </span>
            </li>
          )}
          {commands.map((c, i) => (
            <CommandRow
              // With the index: a list saved before duplicates were refused may hold the same command twice
              key={`${i}-${c.command}`}
              projectId={projectId}
              index={i}
              saved={c}
              run={runs[c.command]}
              current={i === cursor}
              logOpen={logOf === c.command}
              renaming={renaming === c.command}
              onPoint={() => setCursor(i)}
              onToggleLog={() => toggleLog(c.command)}
              onRun={() => run(c.command)}
              onStop={() => stop(c.command)}
              onRename={() => setRenaming(c.command)}
              onRenamed={(label) => rename(c.command, label)}
              onRemove={() => remove(i)}
            />
          ))}
        </ul>

        {/* Adding, below a hairline: where the list ends is the boundary. The command comes first, the name after it */}
        <div className="shrink-0 border-t border-line/60 p-2">
          <div className="flex items-center gap-1">
            <TextInput
              ref={addRef}
              size="sm"
              text="sm"
              font="readout"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setAdding(true)}
              onBlur={() => setAdding(false)}
              onKeyDown={(e) => {
                if (isPlainEnter(e.nativeEvent)) add(draft, draftName)
              }}
              placeholder="Add a command, e.g. pnpm dev"
              aria-label="Command to add"
              data-testid="run-add-input"
              className="min-w-0 flex-1"
            />
            {/* Asked once there is a command to name: an empty name field beside an empty command field is noise */}
            {draft.trim() && (
              <TextInput
                size="sm"
                text="sm"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (!isPlainEnter(e.nativeEvent)) return
                  add(draft, draftName)
                  addRef.current?.focus()
                }}
                placeholder="Name (optional)"
                aria-label="Name for the command"
                data-testid="run-add-name"
                className="w-32 shrink-0"
              />
            )}
            {/* As tall as the fields beside it: the small button alone would sit shorter than them */}
            <Button
              variant="quiet"
              size="sm"
              data-testid="run-add"
              onClick={() => add(draft, draftName)}
              disabled={!draft.trim()}
              className="shrink-0 self-stretch"
            >
              Add
            </Button>
          </div>

          {/*
            What the agent ran in this session, to keep in one click: shown while the add field is focused and empty, or
            when nothing is saved yet. A press here does not take focus from the field, so the list does not fold away
            under the pointer before the click lands.
          */}
          {showSuggestions && (
            <div className="mt-1.5" data-testid="run-suggestions">
              <p className="px-2 pb-0.5 text-2xs text-ink-faint">Run by the agent in this session</p>
              {suggestions.map((command, i) => (
                <button
                  key={command}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(command)}
                  data-testid={`run-suggest-${i}`}
                  aria-label={`Save ${command}`}
                  className="group/sug flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover/60"
                >
                  <span className="shrink-0 text-ink-faint group-hover/sug:text-ink">
                    <PlusIcon size={12} />
                  </span>
                  <span className="readout min-w-0 truncate text-xs text-ink-muted group-hover/sug:text-ink">
                    {command}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One saved command: Run or Stop at its start, its name and command, how it stands, then Restart while it runs and
 * the quiet edits at the end. Its log opens under it.
 */
function CommandRow({
  projectId,
  index: i,
  saved: c,
  run: r,
  current,
  logOpen,
  renaming,
  onPoint,
  onToggleLog,
  onRun,
  onStop,
  onRename,
  onRenamed,
  onRemove,
}: {
  projectId: string
  index: number
  saved: SavedCommand
  run: CommandRun | undefined
  current: boolean
  logOpen: boolean
  renaming: boolean
  onPoint: () => void
  onToggleLog: () => void
  onRun: () => void
  onStop: () => void
  onRename: () => void
  onRenamed: (label: string) => void
  onRemove: () => void
}) {
  const ref = useRef<HTMLLIElement>(null)
  const log = usePresence(logOpen)
  const running = !!r?.running
  // Stop was pressed and the exit has not come back yet
  const stopping = running && !!r?.stopped
  const name = c.label ?? c.command

  // The row the keys move to, and a log just opened, are brought into view in a list that scrolls
  useEffect(() => {
    if (current || logOpen) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [current, logOpen])

  return (
    <li
      ref={ref}
      className={`group/row rounded-lg transition-colors ${current ? 'bg-surface-selected' : 'hover:bg-surface-hover/60'}`}
      onMouseDown={onPoint}
      aria-current={current || undefined}
    >
      <div className="flex items-center gap-0.5 pl-1 pr-1">
        {/* The common act, one click from the list: Run, or Stop while it runs */}
        {running ? (
          <IconButton
            label={stopping ? 'Stopping…' : `Stop ${name}`}
            onClick={onStop}
            disabled={stopping}
            testId={`run-stop-${i}`}
            lit
          >
            <StopIcon size={10} />
          </IconButton>
        ) : (
          <IconButton label={`Run ${name}`} onClick={onRun} testId={`run-exec-${i}`}>
            <PlayIcon size={13} />
          </IconButton>
        )}

        {renaming ? (
          <div className="min-w-0 flex-1 px-1 py-1">
            <TextInput
              size="sm"
              text="sm"
              surface="floor"
              autoFocus
              defaultValue={c.label ?? ''}
              placeholder="Name (blank removes it)"
              aria-label={`Name for ${c.command}`}
              data-testid={`run-rename-input-${i}`}
              className="w-full"
              onKeyDown={(e) => {
                // An Enter that ends a composition does not save (#181) — the last syllable of a Korean name was dropped
                if (isPlainEnter(e.nativeEvent)) onRenamed((e.target as HTMLInputElement).value)
                // Esc is only cleared from `renaming` by the window's listener
              }}
              onBlur={(e) => onRenamed(e.target.value)}
            />
          </div>
        ) : (
          /* A press on the row opens its log, never runs it: running is the button before it */
          <button
            type="button"
            data-testid={`run-command-${i}`}
            aria-expanded={logOpen}
            onClick={onToggleLog}
            className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left"
          >
            {/* The name leads and the command backs it up: every place that shows a name shows its command (2026-09-06) */}
            <span className="min-w-0 flex-1">
              {c.label ? (
                <>
                  <span
                    className={`block truncate text-sm ${current || running ? 'text-ink' : 'text-ink-muted group-hover/row:text-ink'}`}
                  >
                    {c.label}
                  </span>
                  <span className="readout block truncate text-xs text-ink-faint">{c.command}</span>
                </>
              ) : (
                <span
                  className={`readout block truncate text-sm transition-colors ${
                    current || running ? 'text-ink' : 'text-ink-muted group-hover/row:text-ink'
                  }`}
                >
                  {c.command}
                </span>
              )}
            </span>
            {r && <RunState run={r} index={i} />}
            <span
              className={`shrink-0 text-ink-faint transition-opacity ${
                logOpen || current ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
              }`}
            >
              <ChevronIcon open={logOpen} size={14} />
            </span>
          </button>
        )}

        {running && (
          <IconButton label={`Restart ${name}`} onClick={onRun} testId={`run-restart-${i}`} align="right">
            <RestartIcon size={13} />
          </IconButton>
        )}
        {/* Naming and removing come up on hover or focus: a permanent set on every row makes the list noisy */}
        {!renaming && (
          <IconButton
            label={c.label ? `Rename ${c.command}` : `Name ${c.command}`}
            onClick={onRename}
            testId={`run-rename-${i}`}
            align="right"
            className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          >
            <PencilIcon size={12} />
          </IconButton>
        )}
        {/* At the far end, away from Run, since a removal cannot be undone. A running command keeps running */}
        <IconButton
          label={`Remove ${c.command}`}
          onClick={onRemove}
          testId={`run-delete-${i}`}
          align="right"
          className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <CloseIcon size={12} />
        </IconButton>
      </div>

      {/* Its last run's log, in place. A re-run gives a new runId, and the view starts again from scratch */}
      {/* The log opens downward and closes back up (owner, 2026-10-19): kept through its exit by usePresence */}
      {log.shown && (
        <div
          className={`grid px-1 ${log.leaving ? 'cc-collapse' : 'cc-expand'}`}
          data-testid="run-log"
          data-leaving={log.leaving || undefined}
        >
        <div className="min-h-0 overflow-hidden pb-1">
          <div className="h-56 overflow-hidden rounded-md border border-line/60">
            {r ? (
              <CommandLogView
                key={r.runId}
                projectId={projectId}
                command={c.command}
                runId={r.runId}
                surfaceTestId={`run-log-surface-${r.runId}`}
              />
            ) : (
              <p className="flex h-full flex-col items-center justify-center px-3 text-center text-sm text-ink-muted">
                Not run yet
                <span className="mt-0.5 block text-xs text-ink-faint">
                  Its output shows here once it runs
                </span>
              </p>
            )}
          </div>
        </div>
        </div>
      )}
    </li>
  )
}

/**
 * How a command stands, in the readout face: a breathing dot and how long it has run, or a ring and how it ended.
 * A failure (a non-zero exit, or a run that never started) is the dashed ring; a run stopped from Centralu is a stop,
 * not a failure, whatever its signal's exit code.
 */
function RunState({ run: r, index: i }: { run: CommandRun; index: number }) {
  if (r.running) return <Running startedAt={r.startedAt} index={i} />
  const failed = !r.stopped && r.exitCode !== 0
  const what = r.stopped ? 'stopped' : r.exitCode === null ? 'did not start' : `exit ${r.exitCode}`
  return (
    <span
      className={`readout flex shrink-0 items-center gap-1.5 text-2xs ${failed ? 'text-ink-muted' : 'text-ink-faint'}`}
      data-testid={`run-exit-${i}`}
    >
      <RingIcon dashed={failed} />
      {what}
      {r.endedAt !== undefined && (
        <>
          {' · '}
          <RelativeAge when={r.endedAt} />
        </>
      )}
    </span>
  )
}

function Running({ startedAt, index: i }: { startedAt: number; index: number }) {
  const next = useCallback((now: number) => nextElapsedTick(startedAt, now), [startedAt])
  const now = useLabelNow(next)
  return (
    <span className="readout flex shrink-0 items-center gap-1.5 text-2xs text-ink-muted">
      {/* A steady breathe, as the terminal tab's dot: alive, and nothing waits on the person, so not white */}
      <span
        className="breathe size-1.5 shrink-0 rounded-full bg-ink"
        data-testid={`run-running-${i}`}
        role="img"
        aria-label="Running"
      />
      {formatElapsed(Math.floor(Math.max(0, now - startedAt) / 1000))}
    </span>
  )
}

/** First words of a look around (reading files, searching, moving about): not what a person saves to run again */
const LOOKS_AROUND = new Set([
  'awk',
  'cat',
  'cd',
  'echo',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'less',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'tree',
  'wc',
  'which',
])

/** A shell wrapper Codex reports a command inside (`/bin/zsh -lc 'pnpm test'`), unwrapped to what was run */
const SHELL_WRAP = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/

/**
 * The agent's shell commands in this conversation that are worth saving, most repeated first, then most recent: one
 * line, not too long, not a look around, not saved already. Both tools report a shell command as a `Bash` card.
 */
function agentCommands(items: readonly ChatItem[], saved: readonly SavedCommand[]): string[] {
  const have = new Set(saved.map((c) => c.command))
  const seen = new Map<string, { count: number; last: number }>()
  items.forEach((it, at) => {
    if (it.kind !== 'tool' || it.tool !== 'Bash') return
    const command = (SHELL_WRAP.exec(it.title.trim())?.[2] ?? it.title).trim()
    if (!command || command.length > 100 || command.includes('\n') || have.has(command)) return
    if (LOOKS_AROUND.has(command.split(/\s+/)[0] ?? '')) return
    const was = seen.get(command)
    seen.set(command, { count: (was?.count ?? 0) + 1, last: at })
  })
  return [...seen.entries()]
    .sort(([, a], [, b]) => b.count - a.count || b.last - a.last)
    .slice(0, SUGGESTIONS)
    .map(([command]) => command)
}
