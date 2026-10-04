import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SavedCommand } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useOpenLayer } from '../../components/Modal.jsx'
import { isPlainEnter } from './composerKeys.js'
import { registerTerminalHttpLinks } from '../../components/terminalLinks.js'
import { terminalStyle } from '../../components/terminalTheme.js'
import { useStore } from '../../store/store.js'

const NO_COMMANDS: SavedCommand[] = []
const NO_RUNS: Record<string, never> = {}

/**
 * Frequently used commands (#60) — a run window separate from the terminal tab.
 *
 * It used to be that picking one from the small popover in the header would **type it into the
 * terminal tab's PTY**. That meant one-off builds and dev servers alike all settled into the
 * terminal tab, and the narrow popover had no room to show logs either. For a while this was a
 * window covering the whole pane, but a full screen for a handful of list rows was too much
 * (reported by a user on 2026-09-06) — now it is a small window centered on screen, and the log
 * only opens below once a command is picked.
 *
 * The alias (label) was requested the same day: "dev server" reads at a glance better than
 * `pnpm dev`. There is one rule to stop the name from drifting into quietly meaning a different
 * command, though — **every place that shows the alias shows the command too.** Identity always
 * belongs to the command string.
 *
 * One-off and long-running commands are **not distinguished** — if it does not end, the log
 * just keeps streaming, and if it does, the log is left behind along with the exit code. A dev
 * server is simply a command that does not end. Only the single most recent run's log per
 * command is kept on the host (for the app's lifetime) — closing and reopening the window
 * leaves it unchanged **until the same command is run again** (decided by a user on 2026-08-26).
 *
 * Run state belongs not to this window but to the store's record (commandRuns) — even with the
 * window closed, **a running command still stands as a terminal in the terminal panel**, and an
 * exit, wherever it came from, goes through the record and shows up in both places together.
 * The window is the source of truth for registering, running and past logs; the panel is where
 * it lives.
 */
export function CommandRunnerOverlay({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const runCommand = useStore((s) => s.runCommand)
  const stopCommand = useStore((s) => s.stopCommand)
  const [selected, setSelected] = useState<string | null>(null)
  /** Command → last run state (for the badge). LogView holds the log body separately */
  const runs = useStore((s) => s.commandRuns[projectId] ?? NO_RUNS)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  /** The command whose alias is being edited (the command string is the key) */
  const [renaming, setRenaming] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Mid closing-animation — only unmounts via onClose after sliding back up the way it came down */
  const [leaving, setLeaving] = useState(false)
  const leave = useCallback(() => setLeaving(true), [])
  // A layer that covers the pane — while it is open, the approval card underneath does not
  // receive y/n/a (#158)
  useOpenLayer()

  // With reduced-motion, animationend never fires — a timer guarantees the unmount (the same
  // rule as the settings menu)
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(onClose, 200)
    return () => window.clearTimeout(t)
  }, [leaving, onClose])

  // Reads the host's run record on open — a run keeps going even if the window is closed, so
  // reopening it picks up where it left off.
  // (The grid has no evidence panel, so this also has to be read here — the grid path right
  // after a UI reload)
  useEffect(() => {
    void useStore.getState().loadCommandRuns(projectId)
  }, [projectId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // While editing an alias, Esc cancels the edit — closing the window too would collapse
      // both steps at once
      if (renaming !== null) setRenaming(null)
      else leave()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [leave, renaming])

  // Running and stopping both go through the store's record — the terminal panel and tab badge
  // see the same fact (the failure toast comes from there too)
  const run = (command: string) => void runCommand(projectId, command)
  const stop = (command: string) => void stopCommand(projectId, command)

  const add = () => {
    const command = draft.trim()
    if (!command) return
    const label = draftName.trim()
    setDraft('')
    setDraftName('')
    void save(projectId, [...commands, { command, ...(label ? { label } : {}) }])
  }

  const rename = (command: string, label: string) => {
    setRenaming(null)
    const clean = label.trim()
    void save(
      projectId,
      commands.map((c) => (c.command === command ? { command, ...(clean ? { label: clean } : {}) } : c)),
    )
  }

  const sel = selected ? commands.find((c) => c.command === selected) : undefined
  const current = sel?.command ?? null
  const currentRun = current ? runs[current] : undefined

  return (
    /* Clicking the outer margin closes it — ignored if the window itself started the mousedown */
    <div
      ref={rootRef}
      className="absolute inset-0 z-40 flex items-start justify-end bg-surface-floor/40 px-2 pb-4 pt-8"
      data-testid="run-menu"
      onMouseDown={(e) => {
        if (e.target === rootRef.current) leave()
      }}
    >
      {/*
        Attaches as a dropdown below the header's ▶ (requested by a user on 2026-09-06 — a
        centered modal felt too heavy for a handful of list rows). The cc-drop animation
        sliding down from above tells where it came from. The window is only as tall as its
        content, and grows downward once the log is opened.
      */}
      <div
        onAnimationEnd={() => leaving && onClose()}
        className={`flex max-h-full w-[min(560px,100%)] flex-col overflow-hidden rounded-md border border-line bg-surface-raised shadow-(--shadow-dropdown) ${
          leaving ? 'cc-drop-out pointer-events-none' : 'cc-drop'
        }`}
      >
        <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
          <span className="text-xs uppercase text-ink-faint">Commands</span>
          <span className="ml-auto">
            <IconButton label="Close" onClick={leave} testId="run-close" align="right">
              <CloseIcon size={12} />
            </IconButton>
          </span>
        </div>

        {/*
          The command list.

          Rows do not each get a border. They used to be `border-line bg-surface-floor` boxes, and
          since the input just below in the registration area had the exact same shell,
          **the list looked like a row of empty input fields** (reported by a user on
          2026-09-07). But giving rows no background at all makes the list blend into the
          window background and hides where it starts (a second issue reported the same day).

          So **the whole list is one panel, not individual rows**: hairline rules separate the
          rows on top of a floor (bg-surface-floor) one shade darker than the window. A bordered box is
          still reserved for places that take text input, and the list is a settled slab, so
          there is no room to confuse it with an input.
        */}
        <div className="max-h-64 shrink-0 overflow-y-auto border-b border-line bg-surface-floor">
          {commands.length === 0 && (
            <p className="px-3 py-2 text-xs text-ink-faint">
              No saved commands yet — add one below. It runs in the project folder.
            </p>
          )}
          {commands.map((c, i) => {
            const r = runs[c.command]
            return (
              <div
                key={`${i}-${c.command}`}
                className={`group/row flex items-center border-b border-line/60 transition-colors last:border-b-0 ${
                  current === c.command ? 'bg-surface-hover/50' : 'hover:bg-surface-hover/25'
                }`}
              >
                <button
                  type="button"
                  data-testid={`run-command-${i}`}
                  onClick={() => setSelected(c.command)}
                  className="min-w-0 flex-1 px-3 py-1.5 text-left"
                >
                  {renaming === c.command ? (
                    <input
                      autoFocus
                      defaultValue={c.label ?? ''}
                      placeholder="Name (blank removes it)"
                      data-testid={`run-rename-input-${i}`}
                      className="w-full rounded-md border border-line bg-surface-raised px-1 py-0.5 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        // An Enter that ends a composition does not save (#181) — the last
                        // syllable of a Korean-language alias was dropped
                        if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing }))
                          rename(c.command, (e.target as HTMLInputElement).value)
                        // Esc is only cleared from `renaming` by the window listener above
                      }}
                      onBlur={(e) => renaming === c.command && rename(c.command, e.target.value)}
                    />
                  ) : c.label ? (
                    <>
                      <span className="block truncate text-sm text-ink">{c.label}</span>
                      <span className="readout block truncate text-2xs text-ink-faint">{c.command}</span>
                    </>
                  ) : (
                    <span className="readout block truncate py-0.5 text-sm text-ink-muted transition-colors group-hover/row:text-ink">
                      {c.command}
                    </span>
                  )}
                </button>
                {/* Status shows in the list too — the moment the window opens, "which one is
                running" must be readable */}
                {r?.running && (
                  <span
                    className="mr-1 size-1.5 shrink-0 animate-pulse rounded-full bg-ink"
                    data-testid={`run-running-${i}`}
                    aria-label="running"
                  />
                )}
                {r && !r.running && (
                  <span className="readout mr-1 shrink-0 text-2xs text-ink-faint" data-testid={`run-exit-${i}`}>
                    exit {r.exitCode ?? '?'}
                  </span>
                )}
                {/* Adding/editing an alias — hover only (a permanent button set on every row
                would make the list noisy) */}
                <button
                  type="button"
                  data-testid={`run-rename-${i}`}
                  aria-label={`Rename ${c.command}`}
                  onClick={() => setRenaming(c.command)}
                  className="shrink-0 px-1.5 py-1.5 text-2xs text-ink-faint opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/row:opacity-100"
                >
                  {c.label ? 'Rename' : 'Name'}
                </button>
                {/* Delete is a different target from run — extra spacing on the side where a
                wrong click cannot be undone */}
                <button
                  type="button"
                  data-testid={`run-delete-${i}`}
                  aria-label={`Remove ${c.command}`}
                  onClick={() => {
                    if (current === c.command) setSelected(null)
                    void save(projectId, commands.filter((_, j) => j !== i))
                  }}
                  className="shrink-0 rounded-r-md px-2 py-1.5 text-ink-faint transition-colors hover:bg-surface-hover/70 hover:text-ink"
                >
                  <CloseIcon size={10} />
                </button>
              </div>
            )
          })}
        </div>

        {/* Registration — a panel at the bottom, not the list's last row. Where the slab ends
        is the boundary */}
        <div className="shrink-0 p-2">
          <div className="flex items-center gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing })) add()
              }}
              placeholder="Command, e.g. pnpm dev"
              data-testid="run-add-input"
              className="readout min-w-0 flex-1 rounded-md border border-line bg-surface-floor px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (isPlainEnter({ key: e.key, isComposing: e.nativeEvent.isComposing })) add()
              }}
              placeholder="Name (optional)"
              data-testid="run-add-name"
              className="w-32 shrink-0 rounded-md border border-line bg-surface-floor px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            />
            <button
              type="button"
              data-testid="run-add"
              onClick={add}
              className="shrink-0 rounded-md border border-line px-2 py-1.5 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              Add
            </button>
          </div>
        </div>

        {/* Run, stop, log — only once a command is picked. Until then the window stays as
        small as the list */}
        {current && (
          <>
            <div className="flex items-center gap-2 border-y border-line px-3 py-1.5">
              <button
                type="button"
                data-testid="run-exec"
                onClick={() => void run(current)}
                className="rounded-md border border-line px-3 py-1 text-sm text-ink transition-colors hover:border-line-strong hover:bg-surface-hover/25"
              >
                {currentRun?.running ? 'Restart' : 'Run'}
              </button>
              {currentRun?.running && (
                <button
                  type="button"
                  data-testid="run-stop"
                  onClick={() => void stop(current)}
                  className="rounded-md border border-line px-3 py-1 text-sm text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  Stop
                </button>
              )}
              <span className="readout min-w-0 truncate text-xs text-ink-faint" data-testid="run-selected">
                {sel?.label ? `${sel.label} · ${current}` : current}
              </span>
            </div>

            {/* The selected command's log — re-renders from scratch when runId changes (re-run) */}
            <div className="h-64 min-h-0 shrink" data-testid="run-log">
              {currentRun ? (
                <LogView key={currentRun.runId} projectId={projectId} command={current} runId={currentRun.runId} />
              ) : (
                <p className="px-3 py-2 text-xs text-ink-faint">Not run yet — press Run.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * A single log (read-only xterm — the cheapest way to keep color is a terminal emulator).
 * Restoring the screen is the host's log buffer's job: the moment it attaches, it receives all
 * output so far in one shot, and from then on listens to the same stream as a terminal (runId
 * standing in for terminalId).
 */
function LogView({ projectId, command, runId }: { projectId: string; command: string; runId: string }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      // Colours, font and size come from the theme (styles/index.css, --color-term-*)
      ...terminalStyle(el, 'log'),
      disableStdin: true,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const links = registerTerminalHttpLinks(term, (url) => {
      void platform.system
        .openUrl(url)
        .catch((e) => useStore.getState().setToast(`Could not open ${url}: ${(e as Error).message}`))
    })

    const lastDims = { cols: 0, rows: 0 }
    const syncSize = () => {
      try {
        fit.fit()
      } catch {
        // There are moments when there is no layout yet — this gets fitted next time around
      }
      const { cols, rows } = term
      if (cols < 2 || rows < 2) return
      if (cols === lastDims.cols && rows === lastDims.rows) return
      lastDims.cols = cols
      lastDims.rows = rows
      void platform.commands.resize(projectId, command, cols, rows).catch(() => {})
    }
    syncSize()

    // All the log so far, in one shot — the stream subscription is set up first so it does not
    // fall out of order with the chunks that follow
    const pendingChunks: string[] = []
    let replayed = false
    const offOutput = platform.terminal.onOutput((e) => {
      if (e.terminalId !== runId) return
      if (replayed) term.write(e.data)
      else pendingChunks.push(e.data)
    })
    const offExit = platform.terminal.onExit((e) => {
      if (e.terminalId !== runId) return
      term.write(`\r\n\x1b[2m— exited${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
    })
    void platform.commands
      .log(projectId, command)
      .then((run) => {
        // If a re-run gave it a different runId, this view is about to be replaced anyway — do
        // not render the stale log
        if (!run || run.runId !== runId) return
        term.write(run.history)
        for (const chunk of pendingChunks.splice(0)) term.write(chunk)
        replayed = true
        if (!run.running && run.exitCode !== null) {
          term.write(`\r\n\x1b[2m— exited (${run.exitCode}) —\x1b[0m\r\n`)
        }
      })
      .catch(() => {})

    let pending = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(syncSize)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(pending)
      ro.disconnect()
      offOutput()
      offExit()
      links.dispose()
      term.dispose()
    }
  }, [platform, projectId, command, runId])

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={`run-log-surface-${runId}`} />
}
