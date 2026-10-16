import { useEffect, useRef } from 'react'
import { usePlatform } from '../app/PlatformProvider.jsx'
import { logReplay } from './logReplay.js'
import { mountXterm } from './xterm.js'

/**
 * One command's log (a read-only xterm — the cheapest way there is to keep ANSI color, since it is
 * a terminal emulator). Restoring the view on remount is done by the host's log buffer: the moment
 * it attaches, it receives the entire output so far, and after that it listens on the same stream a
 * terminal uses (with runId standing in for terminalId).
 *
 * Shared by the terminal panel's running command and the run dialog's selected command; only the
 * surface's test id differs, so each screen keeps its own.
 */
export function CommandLogView({
  projectId,
  command,
  runId,
  surfaceTestId,
}: {
  projectId: string
  command: string
  runId: string
  surfaceTestId: string
}) {
  const platform = usePlatform()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    return mountXterm(el, platform, 'log', { disableStdin: true, scrollback: 5000 }, (term) => {
      // The whole log so far, at once — the stream subscription is set up first so it does not
      // get out of order with the chunks that follow
      const log = logReplay((data) => term.write(data))
      const offOutput = platform.terminal.onOutput((e) => {
        if (e.terminalId !== runId) return
        log.chunk(e.data)
      })
      const offExit = platform.terminal.onExit((e) => {
        if (e.terminalId !== runId) return
        term.write(`\r\n\x1b[2m— exited${e.exitCode !== null ? ` (${e.exitCode})` : ''} —\x1b[0m\r\n`)
      })
      void platform.commands
        .log(projectId, command)
        .then((run) => {
          if (!run) return log.fail()
          // If a re-run gave it a different runId, this view is about to be replaced — the old log is not drawn
          if (run.runId !== runId) return log.drop()
          log.replay(run.history)
          if (!run.running && run.exitCode !== null) {
            term.write(`\r\n\x1b[2m— exited (${run.exitCode}) —\x1b[0m\r\n`)
          }
        })
        .catch(() => log.fail())

      return {
        // A new code font changes the cell size: the command is told its new size
        onSize: (cols, rows) => void platform.commands.resize(projectId, command, cols, rows).catch(() => {}),
        dispose: () => {
          offOutput()
          offExit()
        },
      }
    })
  }, [platform, projectId, command, runId])

  return <div ref={hostRef} className="h-full px-1 py-1" data-testid={surfaceTestId} />
}
