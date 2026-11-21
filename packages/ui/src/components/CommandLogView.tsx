import { useEffect, useRef } from 'react'
import { usePlatform } from '../app/PlatformProvider.jsx'
import { logReplay } from './logReplay.js'
import { mountXterm } from './xterm.js'

/**
 * One command's log in a read-only xterm, the cheapest way to keep ANSI colour; for the terminal panel's running command
 * and the run dialog's. On attach the host's log buffer sends all output so far, then the terminal stream follows
 * (runId as the terminalId).
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
      // Subscribed before the log is read, so no chunk falls between (logReplay)
      const log = logReplay((data) => term.write(data))
      const offOutput = platform.terminal.onOutput((e) => {
        if (e.terminalId !== runId) return
        log.chunk(e.data)
      })
      const offExit = platform.terminal.onExit((e) => {
        if (e.terminalId !== runId) return
        log.exit(e.exitCode)
      })
      void platform.commands
        .log(projectId, command)
        .then((run) => {
          if (!run) return log.fail()
          // A re-run gave it another runId: this view is about to be replaced
          if (run.runId !== runId) return log.drop()
          log.replay(run.history, run.running ? null : run.exitCode)
        })
        .catch(() => log.fail())

      return {
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
