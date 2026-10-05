import { useEffect } from 'react'
import { runsOlderCli } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../store/store.js'

/**
 * "Claude Code 2.1.290 installed — this session runs 2.1.282" (#297).
 *
 * Every session runs its own agent process, and an update to the CLI reaches it only when that process starts again.
 * With the keeper holding processes across app restarts, a session can run an old CLI for weeks with nothing saying
 * so. This line says so, quietly — it is information, not a warning: the session works as it did.
 *
 * Next to it, one app-wide action: restart every idle session on the installed version. It is app-wide because the
 * update is: a person who just updated `claude` wants all of their sessions on it, not to visit each one. A session
 * that is busy is left alone and keeps the line.
 *
 * Shown only for a live session whose version and the installed one are both known, and when the installed one is
 * newer — `runsOlderCli`, the comparison the host restarts by, so the line never offers what the host would refuse.
 */
export function AgentVersionNotice({ session }: { session: SessionSummary }) {
  /*
   * Compared with the CLI installed **where the session runs** (#82): a session on a linked machine runs that machine's
   * CLI, and comparing it with this computer's would offer a restart the remote host refuses, or miss one it would do.
   */
  const machine = session.machine ?? null
  const versions = useStore((s) => (machine ? s.machineAgentVersions[machine] : s.agentVersions) ?? null)
  const installed = versions?.installed[session.tool] ?? null
  const autoApply = versions?.autoApply ?? false
  const label = useStore((s) => s.tools.find((t) => t.name === session.tool)?.label ?? session.tool)
  const apply = useStore((s) => s.applyAgentVersions)
  const check = useStore((s) => s.checkMachineAgentVersions)
  const known = versions !== null
  // Asked once, when a live remote session's header first needs it; the machine's resync asks again
  useEffect(() => {
    if (machine && session.live && !known) void check(machine)
  }, [machine, session.live, known, check])
  if (!session.live || !runsOlderCli(session.agentVersion, installed)) return null
  const text = `${label} ${installed} installed — this session runs ${session.agentVersion}`
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="agent-version-notice">
      <span
        className="readout truncate text-xs text-ink-faint"
        data-testid="agent-version-text"
        title={
          autoApply
            ? `${text}. It restarts on ${installed} by itself once it is idle; the conversation continues.`
            : `${text}. The conversation continues after a restart.`
        }
      >
        {text}
      </span>
      <button
        className="shrink-0 rounded-md border border-line px-1.5 text-2xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
        data-testid="agent-version-apply"
        title="Restart every idle session on the installed version. Busy sessions keep running."
        onClick={() => void apply(machine)}
      >
        Update idle sessions
      </button>
    </span>
  )
}
