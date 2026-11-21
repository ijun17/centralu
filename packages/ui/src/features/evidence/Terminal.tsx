import { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal as Xterm } from '@xterm/xterm'
import { errorMessage, type CommandRunInfo, type TerminalInfo } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { CloseIcon, PlusIcon, RestartIcon, StopIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { CommandLogView } from '../../components/CommandLogView.jsx'
import { mountXterm } from '../../components/xterm.js'
import { useStore } from '../../store/store.js'
import { resyncsOf } from '../../store/machines.js'
import { TabActions } from './tabActions.jsx'

/**
 * A terminal belongs to the directory, not the session, so a dev server or `tail` survives a session switch (a worktree
 * session has its own). They stack in the tall, narrow panel; each has its own close, since fewer is how one gets larger.
 */
export function TerminalPane({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A saved command stands here only while the ledger says `running` (#60); past logs live in the run window
  // (CommandRunner). The record is selected as-is: a selector building a new array would re-render forever.
  const cmdRuns = useStore((s) => s.commandRuns[projectId])
  const runningCmds = Object.values(cmdRuns ?? {})
    .filter((r) => r.running)
    .sort((a, b) => a.startedAt - b.startedAt)

  // Only the latest request writes: a late answer after a project switch would draw, or even create, the old project's terminals
  const loadGen = useRef(0)

  // Output between a terminal's snapshot (`history` in the list or create answer) and its view subscribing a render later
  // (#842 item 5), held until the view takes it (`takeEarly`). Held from the answer, not the request: events and answers
  // share one ordered connection, so earlier output is in the snapshot.
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
      // An empty pane would cost one more press
      if (list.length === 0) {
        const t = await platform.terminal.create(projectId, 80, 24)
        if (gen !== loadGen.current) return
        holdEarly([t])
        setTerminals([t])
        setError(null)
        return
      }
      // A view already mounted listens for itself
      holdEarly(list.filter((t) => !mounted.current.has(viewKey(resyncs.current, t.terminalId))))
      setTerminals(list)
      // The line reports the last attempt (#1143 U19)
      setError(null)
    } catch (e) {
      if (gen === loadGen.current) setError(errorMessage(e))
    }
  }, [platform, projectId])

  // A resync (reconnect, host swap, the machine's host restarted by an update, #1902) re-reads and remounts (#842 item 4):
  // old views miss the gap's output, a dead shell's exit (so no Restart), and send keys to shells the new host dropped.
  const hostResyncs = useStore((s) => resyncsOf(s, projectId))
  const resyncs = useRef(hostResyncs)
  resyncs.current = hostResyncs

  useEffect(() => {
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
      setError(errorMessage(e))
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
        No header bar of its own: it would repeat the tab. The button is portalled into the tab strip, state kept here.
      */}
      <TabActions>
        <IconButton label="New terminal" onClick={() => void add()} testId="terminal-add" align="right">
          <PlusIcon size={16} />
        </IconButton>
      </TabActions>

      {error && (
        <LoadFailed
          what="the terminal"
          error={error}
          onRetry={() => {
            setError(null)
            void load()
          }}
          className="px-3 py-2"
          testId="terminal-error"
        />
      )}
      {terminals === null && !error && (
        <SkeletonLines lines={3} className="px-3 py-2" label="Opening the terminal" />
      )}

      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-stack">
        {/* Commands on top, so what was just run shows without scrolling */}
        {runningCmds.map((r) => (
          <CommandTerminal key={r.runId} projectId={projectId} run={r} />
        ))}
        {/*
          TerminalView hands back the id to close: a restart gets a new one.
        */}
        {(terminals ?? []).map((t) => (
          /* The resync count is in the key, so views remount even when the empty and new lists batch into one render */
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

/** One running command (#60). Its button stops it; the panel goes when the exit clears the ledger's flag */
function CommandTerminal({ projectId, run }: { projectId: string; run: CommandRunInfo }) {
  const stopCommand = useStore((s) => s.stopCommand)
  // A name always shows with its command: the two can drift apart
  const label = useStore((s) => s.projects[projectId]?.commands.find((c) => c.command === run.command)?.label)
  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-line last:border-b-0"
      data-testid={`cmd-term-${run.command}`}
    >
      <div className="flex items-center gap-1.5 px-3 py-1">
        <span className="breathe size-1.5 shrink-0 rounded-full bg-ink" role="img" aria-label="A command is running" />
        {label && <span className="truncate text-2xs text-ink-muted">{label}</span>}
        <span className="readout truncate text-2xs text-ink-faint" title={run.command}>
          {run.command}
        </span>
        <span className="ml-auto">
          <IconButton
            label="Stop command (the log stays in the run window)"
            onClick={() => void stopCommand(projectId, run.command)}
            testId={`cmd-term-stop-${run.command}`}
            align="right"
          >
            <StopIcon />
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

/** The same shell after a resync is a new view */
function viewKey(resyncs: number, terminalId: string): string {
  return `${resyncs}:${terminalId}`
}

/** Unmounting does not kill the shell; a remount redraws from the host's scrollback */
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
  mounted: Set<string>
  onClose: (terminalId: string) => void
}) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const idRef = useRef(info.terminalId)
  /**
   * Written once, on first attach, and kept out of the deps: a close re-reads the list with new snapshots, and a rebuilt
   * xterm starts at 80×24, resizes, and makes the shell redraw its prompt, a line more per close.
   */
  const historyRef = useRef(info.history)
  historyRef.current = info.history
  const [dead, setDead] = useState(!info.alive)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    // Grayscale is our screens' rule, not the shell's output's; colours, font and size come from the theme
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
        // Only a real change: a new size makes the shell redraw
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
    // A new history or title does not reattach
  }, [platform, info.terminalId, key, takeEarly, mounted])

  // One restart at a time (#842 item 10), and none written into a terminal disposed meanwhile
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
      if (termRef.current === term) term.write(`\r\n\x1b[2m— could not restart: ${errorMessage(e)} —\x1b[0m\r\n`)
    } finally {
      restarting.current = false
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col border-b border-line last:border-b-0"
      data-testid={`terminal-${info.terminalId}`}
    >
      <div className="flex items-center gap-1.5 px-3 py-1">
        <span className="readout truncate text-2xs text-ink-faint">{info.title}</span>
        {dead && (
          <IconButton
            label="Restart the shell"
            onClick={() => void restart()}
            testId={`terminal-restart-${info.terminalId}`}
          >
            <RestartIcon size={12} />
          </IconButton>
        )}
        <span className="ml-auto">
          <IconButton
            label="Close terminal (the shell exits)"
            // The current id: a restart changes it
            onClick={() => onClose(idRef.current)}
            testId={`terminal-close-${info.terminalId}`}
            align="right"
          >
            <CloseIcon size={11} />
          </IconButton>
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-3 pb-1" data-testid={`terminal-surface-${info.terminalId}`} />
    </div>
  )
}
