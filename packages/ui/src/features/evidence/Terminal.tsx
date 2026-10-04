import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { CommandRunInfo, TerminalInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { registerTerminalHttpLinks } from '../../components/terminalLinks.js'
import { terminalStyle } from '../../components/terminalTheme.js'
import { useStore } from '../../store/store.js'
import { TabActions } from './tabActions.jsx'

/**
 * A project's terminals (there can be several).
 *
 * **A terminal belongs to the project (more precisely, the directory).** Not to the session.
 * So switching sessions within the same project leaves the same shells running uninterrupted —
 * a dev server or a `tail` left running would be useless if it died every time the session changed.
 * (A git worktree session has its own directory, so it automatically gets its own terminals.)
 *
 * The panel is tall and narrow, so terminals stack vertically. To see one larger, the right move is
 * reducing the count, not the panel's width — so close is placed on each individual terminal.
 */
export function TerminalPane({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  /*
   * A running frequently-used command (#60, user decision 2026-09-06) — stands as its own terminal
   * **only while it is running.** Once it ends for any reason (normal exit, crash, Stop), that
   * terminal comes down: the moment the ledger's `running` flag turns off is the moment it is torn
   * down. Past logs are kept as the source of truth by the run window (CommandRunner) — this is
   * only the spot for "what is running right now." The record reference has to be selected as-is —
   * if the selector built a new array every time, it would be an infinite re-render.
   */
  const cmdRuns = useStore((s) => s.commandRuns[projectId])
  const runningCmds = Object.values(cmdRuns ?? {})
    .filter((r) => r.running)
    .sort((a, b) => a.startedAt - b.startedAt)

  /*
   * A request generation number. If the project changes while a list is being awaited, a late
   * response would draw **another project's terminals**, and if that list came back empty, it
   * would even create a terminal for the old project — this makes sure only the latest request is
   * allowed to write to the screen.
   */
  const loadGen = useRef(0)
  const load = useCallback(async () => {
    const gen = ++loadGen.current
    try {
      const list = await platform.terminal.list(projectId)
      if (gen !== loadGen.current) return
      // Opening it the first time needs at least one — an empty screen with only a button is one extra step
      if (list.length === 0) {
        const t = await platform.terminal.create(projectId, 80, 24)
        if (gen !== loadGen.current) return
        setTerminals([t])
        return
      }
      setTerminals(list)
    } catch (e) {
      if (gen === loadGen.current) setError((e as Error).message)
    }
  }, [platform, projectId])

  useEffect(() => {
    // The project changed — the old project's shells must not stay showing
    setTerminals(null)
    setError(null)
    void load()
  }, [load])

  const add = async () => {
    try {
      const t = await platform.terminal.create(projectId, 80, 24)
      setTerminals((prev) => [...(prev ?? []), t])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const close = async (terminalId: string) => {
    await platform.terminal.close(terminalId).catch(() => {})
    // Closing one renumbers the rest, so the whole list is re-read
    await load()
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="evidence-terminal">
      {/*
        No separate header bar is used (user request, 2026-09-07). The label 'Terminal' was already
        saying exactly what the tab right above it said, and two bars pushed the content's starting
        point down by that much in a narrow panel. The button goes to the right end of the tab strip
        instead — it is a portal, so the state stays right here.
      */}
      <TabActions>
        <IconButton label="New terminal" onClick={() => void add()} testId="terminal-add" align="right">
          <PlusIcon size={16} />
        </IconButton>
      </TabActions>

      {error && (
        <p className="px-3 py-2 text-[11px] leading-relaxed text-ink-muted" data-testid="terminal-error">
          Could not open terminal — {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-stack">
        {/* Command terminals go on top — what was just run has to be visible without scrolling. Shells always live below them */}
        {runningCmds.map((r) => (
          <CommandTerminal key={r.runId} projectId={projectId} run={r} />
        ))}
        {/*
          The id to close is handed back by TerminalView — restarting has the host issue **a new
          id**, and closing by the list's t.terminalId would close the old, already-dead id, so
          close would never actually work.
        */}
        {(terminals ?? []).map((t) => (
          <TerminalView key={t.terminalId} info={t} onClose={(id) => void close(id)} />
        ))}
      </div>
    </section>
  )
}

/**
 * One running command — a panel standing next to the shell terminals (#60's final shape).
 *
 * The × means **stop**, not close: this panel only exists while there is a run, so the two mean the
 * same thing. Even Stop's outcome comes back as an exit event, turns off the ledger flag, and the
 * panel comes down at that moment.
 */
function CommandTerminal({ projectId, run }: { projectId: string; run: CommandRunInfo }) {
  const stopCommand = useStore((s) => s.stopCommand)
  // Alias rule (2026-09-06): wherever a name is shown, the command is also shown alongside it — a name can drift out of sync
  const label = useStore((s) => s.projects[projectId]?.commands.find((c) => c.command === run.command)?.label)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-line last:border-b-0"
      data-testid={`cmd-term-${run.command}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink" aria-label="running" />
        {label && <span className="truncate text-[10px] text-ink-muted">{label}</span>}
        <span className="readout truncate text-[10px] text-ink-faint" title={run.command}>
          {run.command}
        </span>
        <span className="ml-auto">
          <IconButton
            label="Stop the command (the log stays in the run window)"
            onClick={() => void stopCommand(projectId, run.command)}
            testId={`cmd-term-stop-${run.command}`}
            align="right"
          >
            <CloseIcon size={11} />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <CommandLog projectId={projectId} command={run.command} runId={run.runId} />
      </div>
    </div>
  )
}

/**
 * One command's log (a read-only xterm — the cheapest way there is to keep ANSI color, since it is
 * a terminal emulator). Restoring the view on remount is done by the host's log buffer: the moment
 * it attaches, it receives the entire output so far, and after that it listens on the same stream a
 * terminal uses (with runId standing in for terminalId).
 */
function CommandLog({ projectId, command, runId }: { projectId: string; command: string; runId: string }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      fontSize: 11,
      // Colours and font come from the theme (styles/index.css, --color-term-*)
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
        // There are times layout does not exist yet — it gets fitted on the next opportunity
      }
      const { cols, rows } = term
      if (cols < 2 || rows < 2) return
      if (cols === lastDims.cols && rows === lastDims.rows) return
      lastDims.cols = cols
      lastDims.rows = rows
      void platform.commands.resize(projectId, command, cols, rows).catch(() => {})
    }
    syncSize()

    // The whole log so far, at once — the stream subscription is set up first so it does not get out of order with the chunks that follow
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
        // If a re-run gave it a different runId, this view is about to be replaced — the old log is not drawn
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

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={`cmd-log-surface-${runId}`} />
}

/**
 * One terminal.
 *
 * Restoring the view is done by the host's scrollback. Switching tabs away and back, or closing and
 * reopening the window, redraws it by receiving the output so far the moment it reattaches.
 * The component disappearing does **not kill the shell** — it just means the tab was switched away.
 */
function TerminalView({ info, onClose }: { info: TerminalInfo; onClose: (terminalId: string) => void }) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const idRef = useRef(info.terminalId)
  /**
   * The size last reported to the shell.
   *
   * **The same size must not be sent again.** A pty resize triggers SIGWINCH, and the shell redraws
   * its prompt. But `fit()` touches the element's layout, which wakes ResizeObserver again, so
   * without this guard a feedback loop would keep running even when the size never actually changed
   * — on screen it would look like the prompt line growing endlessly (a finding from dogfooding).
   */
  const lastDims = useRef({ cols: 0, rows: 0 })
  /**
   * The past output written only once, on first attach.
   *
   * Must not be read directly from props: closing one terminal re-reads the whole list, and at that
   * point **the history of the surviving terminals also changes to a new snapshot.** Putting that
   * in the dependency array would re-run the effect and recreate xterm entirely, and the newly
   * created terminal would start at its default size (80×24) and then immediately get resized to
   * its actual size, making the shell redraw its prompt — it would look like a line growing every
   * time something is closed (a finding raised twice during dogfooding).
   */
  const historyRef = useRef(info.history)
  historyRef.current = info.history
  const [dead, setDead] = useState(!info.alive)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    const term = new Xterm({
      fontSize: 11,
      // The strict-grayscale rule belongs to our own screens; it does not take color away from a
      // shell's own output. Colours and font come from the theme (styles/index.css, --color-term-*).
      ...terminalStyle(el, 'shell'),
      cursorBlink: true,
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
    termRef.current = term

    const safeFit = () => {
      try {
        fit.fit()
      } catch {
        // There are times layout does not exist yet — it gets fitted on the next opportunity
      }
    }
    /** Notifies the shell **only when the size has actually changed** */
    const syncSize = () => {
      safeFit()
      const { cols, rows } = term
      if (cols < 2 || rows < 2) return
      if (cols === lastDims.current.cols && rows === lastDims.current.rows) return
      lastDims.current = { cols, rows }
      void platform.terminal.resize(idRef.current, cols, rows).catch(() => {})
    }

    safeFit()
    if (historyRef.current) term.write(historyRef.current)
    // A new xterm starts at its default size — this must notify once unconditionally, without comparing to a previous value
    lastDims.current = { cols: 0, rows: 0 }
    syncSize()

    const offOutput = platform.terminal.onOutput((e) => {
      if (e.terminalId === idRef.current) term.write(e.data)
    })
    const offExit = platform.terminal.onExit((e) => {
      if (e.terminalId !== idRef.current) return
      setDead(true)
      term.write(`\r\n\x1b[2m— shell exited${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
    })
    const onData = term.onData((data) => {
      void platform.terminal.input(idRef.current, data).catch(() => {})
    })

    // If the panel width or window size changes, the shell has to be told too, or line wrapping
    // breaks. The observer callback is deferred by one frame to coalesce rapid changes into one.
    let pending = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending)
      pending = requestAnimationFrame(syncSize)
    })
    ro.observe(el)

    return () => {
      cancelAnimationFrame(pending)
      ro.disconnect()
      onData.dispose()
      offOutput()
      offExit()
      links.dispose()
      term.dispose()
      termRef.current = null
    }
    // **Identity is terminalId alone.** history or title changing does not cause it to reattach
  }, [platform, info.terminalId])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-line last:border-b-0"
      data-testid={`terminal-${info.terminalId}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="readout truncate text-[10px] text-ink-faint">{info.title}</span>
        {dead && (
          <button
            className="rounded px-1 text-[10px] text-ink-muted transition-colors hover:text-ink"
            data-testid={`terminal-restart-${info.terminalId}`}
            onClick={async () => {
              const term = termRef.current
              if (!term) return
              const next = await platform.terminal.restart(idRef.current, term.cols, term.rows)
              idRef.current = next.terminalId
              setDead(!next.alive)
              term.reset()
              if (next.history) term.write(next.history)
            }}
          >
            Restart
          </button>
        )}
        <span className="ml-auto">
          <IconButton
            label="Close terminal (the shell exits)"
            // Not the id from props but the **current** id — if it has been restarted, the two differ
            onClick={() => onClose(idRef.current)}
            testId={`terminal-close-${info.terminalId}`}
            align="right"
          >
            <CloseIcon size={11} />
          </IconButton>
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-1 pb-1" data-testid={`terminal-surface-${info.terminalId}`} />
    </div>
  )
}
