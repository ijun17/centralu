import { useMemo, useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useTools } from '../../store/selectors.js'
import { useLoad } from '../../app/useLoad.js'
import { useRefusals } from '../project/useToolChoice.js'
import { PastConversations } from './PastConversations.jsx'

/**
 * What a new session's empty screen offers before its first message: which tool runs it, and the project's past
 * conversations of that tool to continue instead.
 *
 * The `+` starts a session at once with the tool the project remembers, so the choice of tool moved here, where the
 * person already is, instead of a dialog before it. Picking the other tool switches this same session to it: no
 * second session is made and none is removed.
 */
export function SessionStart({
  sessionId,
  projectId,
  tool,
}: {
  sessionId: string
  projectId: string
  tool: string
}) {
  return (
    /*
     * Fills the space the empty conversation yields (ChatStream's yieldSpace) and stands near its middle (owner,
     * 2026-10-18). The switch is pinned by fixed shares of the space above and below it, not centred with the list:
     * centring the whole would move the switch each time the list's height settled (loading, then the rows, or none).
     */
    <div className="flex min-h-0 flex-1 flex-col items-center px-4" data-testid="session-start">
      <div className="min-h-6 flex-[2]" aria-hidden />
      <ToolSwitch sessionId={sessionId} projectId={projectId} tool={tool} />
      <div className="flex min-h-0 w-full max-w-[560px] flex-[3] flex-col overflow-y-auto pb-6">
        <PastConversations sessionId={sessionId} projectId={projectId} tool={tool} />
      </div>
    </div>
  )
}

function ToolSwitch({ sessionId, projectId, tool }: { sessionId: string; projectId: string; tool: string }) {
  const tools = useTools()
  const platform = useStore((s) => s.platform)
  const machine = useStore((s) => s.projects[projectId]?.machine ?? null)
  // Asked on the project's machine (#82): a project on a linked machine runs that machine's CLIs
  const found = useLoad(
    () => (platform ? platform.agents.detect(machine ?? undefined) : Promise.resolve([])),
    [platform, machine],
  )
  const [busy, setBusy] = useState<ToolName | null>(null)
  // A tool that cannot keep what this project asks (an untrusted project, `launchRefusal`) is left out like one not installed
  const trusted = useStore((s) => !!s.projects[projectId]?.trusted)
  // Asked with the session's own preset and role (#1562 review): the switch keeps both, so a tool must keep them too
  const preset = useStore((s) => s.sessions[sessionId]?.permissionPreset ?? 'normal')
  // Role text by its kind; a builder's fixed role the window does not hold, and the host refuses that switch itself
  const roleText = useStore((s) => s.sessions[sessionId]?.kind === 'orchestrator' || s.sessions[sessionId]?.kind === 'coordinator')
  const demands = useMemo(() => ({ permissionPreset: preset, projectTrusted: trusted, roleText }), [preset, trusted, roleText])
  const refusal = useRefusals(found.data ?? null, demands, machine ?? undefined)

  /*
   * Only the tools that can run on the project's machine are offered (owner, 2026-10-18): one not installed or not
   * logged in there is left out, not shown greyed, since the list will grow (OpenCode and others) and a row of dead
   * buttons says nothing useful. The session's own tool always stands, alone if it is the only one, so the screen's
   * shape does not change when the answer comes; until then a placeholder stands for the others. If the question
   * fails, every tool is offered and the switch itself says what went wrong.
   */
  const ready = (t: ToolName) => {
    if (found.error) return true
    const d = found.data?.find((x) => x.name === t)
    return !!d && d.installed && d.loggedIn && refusal(t) === null
  }
  const shown = tools.filter((t) => t.name === tool || ready(t.name))
  // Still asking the machine: the session's own tool, and a placeholder where the others will stand
  const asking = found.loading && !found.data && !found.error

  // The same session takes the other tool (`agents.switchTool`): nothing was said yet, so nothing is lost, and the slot,
  // its place in the sidebar and a draft already typed all stay
  const pick = async (t: ToolName) => {
    if (t === tool || busy) return
    setBusy(t)
    try {
      await useStore.getState().switchTool(sessionId, t)
      useStore.getState().askComposerFocus(sessionId)
    } finally {
      setBusy(null)
    }
  }

  return (
    /*
      The tools as one segmented capsule (owner, 2026-10-18), the top bar's shape: the chosen one filled a full hover
      step, the others quiet until hovered.
    */
    <div
      className="inline-flex gap-0.5 rounded-full border border-line p-0.5"
      role="radiogroup"
      aria-label="Tool"
      data-testid="session-start-tools"
    >
      {shown.map((t) => {
        const on = t.name === tool
        return (
          <button
            key={t.name}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy !== null}
            onClick={() => void pick(t.name)}
            data-testid={`session-start-tool-${t.name}`}
            className={`rounded-full px-3.5 py-1 text-sm transition-colors disabled:cursor-default ${
              on
                ? 'bg-surface-hover text-ink'
                : 'text-ink-muted hover:bg-surface-hover/50 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent'
            }`}
          >
            {busy === t.name ? 'Switching…' : t.label}
          </button>
        )
      })}
      {asking && (
        <span
          className="cc-skeleton h-7 w-20 animate-pulse rounded-full bg-surface-hover/50"
          role="status"
          aria-label="Looking for other tools"
        />
      )}
    </div>
  )
}
