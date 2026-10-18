import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as Xterm } from '@xterm/xterm'
import type { CommandRunInfo, TerminalInfo } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { CommandLogView } from '../../components/CommandLogView.jsx'
import { mountXterm } from '../../components/xterm.js'
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

  /*
   * Output that arrives between a terminal's snapshot (its `history` in the answer to list or create) and the moment its
   * view mounts and subscribes (#842 item 5). The view mounts a render after the answer, and a dev server printing in
   * between lost those lines for good: they were not in the snapshot and nobody was listening yet. The pane listens all
   * along, keeps what comes for a terminal from its answer until its view takes it (`takeEarly`), and the view writes
   * the snapshot, then this, then listens, with nothing in between.
   *
   * It starts at the answer, not at the request: what the host sent before its answer is already in the snapshot, since
   * the events and the answer come down one connection in order.
   */
  const early = useRef(new Map<string, string[]>())
  useEffect(
    () =>
      platform.terminal.onOutput((e) => {
        early.current.get(e.terminalId)?.push(e.data)
      }),
    [platform],
  )
  /** The views on screen (`viewKey`), so a re-read holds output only for the ones about to mount */
  const mounted = useRef(new Set<string>())
  const holdEarly = (list: readonly TerminalInfo[]) => {
    for (const t of list) early.current.set(t.terminalId, [])
  }
  const takeEarly = useCallback((terminalId: string) => {
    const held = early.current.get(terminalId) ?? []
    early.current.delete(terminalId)
    return held
  }, [])

  const load = useCallback(async () => {
    const gen = ++loadGen.current
    try {
      const list = await platform.terminal.list(projectId)
      if (gen !== loadGen.current) return
      // Opening it the first time needs at least one — an empty screen with only a button is one extra step
      if (list.length === 0) {
        const t = await platform.terminal.create(projectId, 80, 24)
        if (gen !== loadGen.current) return
        holdEarly([t])
        setTerminals([t])
        setError(null)
        return
      }
      // Only for the ones not on screen yet: a view already mounted listens for itself
      holdEarly(list.filter((t) => !mounted.current.has(viewKey(resyncs.current, t.terminalId))))
      setTerminals(list)
      // The line says what the last thing tried did: an answer clears the reason an earlier one failed (#1143 U19)
      setError(null)
    } catch (e) {
      if (gen === loadGen.current) setError((e as Error).message)
    }
  }, [platform, projectId])

  /*
   * A reconnect that had to resync, or a host swap, reads the terminals again and mounts them fresh (#842 item 4). The
   * views on screen were attached to a connection that is gone: output from the gap was missing, a shell that died
   * meanwhile never got its exit (so no Restart), and a shell the new host did not keep took keys that went nowhere.
   * A fresh list carries each shell's scrollback and whether it is alive, and drops the ones that are gone.
   */
  const hostResyncs = useStore((s) => s.hostResyncs)
  const resyncs = useRef(hostResyncs)
  resyncs.current = hostResyncs

  useEffect(() => {
    // The project changed, or the host was resynced — the shells on screen must not stay showing
    early.current.clear()
    setTerminals(null)
    setError(null)
    void load()
  }, [load, hostResyncs])

  const add = async () => {
    try {
      const t = await platform.terminal.create(projectId, 80, 24)
      holdEarly([t])
      setTerminals((prev) => [...(prev ?? []), t])
      setError(null)
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
        <p className="px-3 py-2 text-xs leading-body text-ink-muted" data-testid="terminal-error">
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
          /*
            The resync count is part of the key, so a resync mounts every view fresh even when the new list answers
            before the empty one was drawn and the two renders are batched into one.
          */
          <TerminalView
            key={viewKey(hostResyncs, t.terminalId)}
            viewKey={viewKey(hostResyncs, t.terminalId)}
            info={t}
            takeEarly={takeEarly}
            mounted={mounted.current}
            onClose={(id) => void close(id)}
          />
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
        {label && <span className="truncate text-2xs text-ink-muted">{label}</span>}
        <span className="readout truncate text-2xs text-ink-faint" title={run.command}>
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
        <CommandLogView
          projectId={projectId}
          command={run.command}
          runId={run.runId}
          surfaceTestId={`cmd-log-surface-${run.runId}`}
        />
      </div>
    </div>
  )
}

/**
 * One terminal.
 *
 * Restoring the view is done by the host's scrollback. Switching tabs away and back, or closing and
 * reopening the window, redraws it by receiving the output so far the moment it reattaches.
 * The component disappearing does **not kill the shell** — it just means the tab was switched away.
 */
/** A terminal's view on screen: the same shell after a resync is a new view */
function viewKey(resyncs: number, terminalId: string): string {
  return `${resyncs}:${terminalId}`
}

function TerminalView({
  viewKey: key,
  info,
  takeEarly,
  mounted,
  onClose,
}: {
  viewKey: string
  info: TerminalInfo
  /** What the pane kept for this terminal since its snapshot (#842 item 5) */
  takeEarly: (terminalId: string) => string[]
  /** The pane's record of which views are on screen */
  mounted: Set<string>
  onClose: (terminalId: string) => void
}) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const idRef = useRef(info.terminalId)
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

    // The strict-grayscale rule belongs to our own screens; it does not take color away from a
    // shell's own output. Colours, font and size come from the theme (styles/index.css).
    return mountXterm(el, platform, 'shell', { cursorBlink: true, scrollback: 5000 }, (term, fit) => {
      termRef.current = term
      fit()
      // The snapshot, then what came after it, then live: one synchronous run, so no chunk falls between (#842 item 5)
      if (historyRef.current) term.write(historyRef.current)
      for (const chunk of takeEarly(info.terminalId)) term.write(chunk)
      mounted.add(key)

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

      return {
        // The shell is told its new size, which makes it redraw — so only a real change is sent
        onSize: (cols, rows) => void platform.terminal.resize(idRef.current, cols, rows).catch(() => {}),
        dispose: () => {
          onData.dispose()
          offOutput()
          offExit()
          mounted.delete(key)
          termRef.current = null
        },
      }
    })
    // **Identity is terminalId alone.** history or title changing does not cause it to reattach
  }, [platform, info.terminalId, key, takeEarly, mounted])

  /*
   * One restart at a time (#842 item 10): a second click while the first was on its way restarted the shell twice, and
   * an answer that came back after the view was gone wrote into a disposed terminal.
   */
  const restarting = useRef(false)
  const restart = async () => {
    const term = termRef.current
    if (!term || restarting.current) return
    restarting.current = true
    try {
      const next = await platform.terminal.restart(idRef.current, term.cols, term.rows)
      if (termRef.current !== term) return
      idRef.current = next.terminalId
      setDead(!next.alive)
      term.reset()
      if (next.history) term.write(next.history)
    } catch (e) {
      if (termRef.current === term) term.write(`\r\n\x1b[2m— could not restart: ${(e as Error).message} —\x1b[0m\r\n`)
    } finally {
      restarting.current = false
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-line last:border-b-0"
      data-testid={`terminal-${info.terminalId}`}
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <span className="readout truncate text-2xs text-ink-faint">{info.title}</span>
        {dead && (
          <button
            className="rounded-md px-1 text-2xs text-ink-muted transition-colors hover:text-ink"
            data-testid={`terminal-restart-${info.terminalId}`}
            onClick={() => void restart()}
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
