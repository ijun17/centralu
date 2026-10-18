import { useState } from 'react'
import type { ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { useTools } from '../../store/selectors.js'
import { useLoad } from '../../app/useLoad.js'
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
    <div
      className="mx-auto flex w-full max-w-[560px] flex-col items-center px-4 pt-6"
      data-testid="session-start"
    >
      <ToolSwitch sessionId={sessionId} projectId={projectId} tool={tool} />
      <PastConversations sessionId={sessionId} projectId={projectId} tool={tool} />
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

  /*
   * Only the tools that can run on the project's machine are offered (owner, 2026-10-18): one not installed or not
   * logged in there is left out, not shown greyed, since the list will grow (OpenCode and others) and a row of dead
   * buttons says nothing useful. The session's own tool always stands. Until the machine answers only that one shows;
   * if the question fails, every tool is offered and the switch itself says what went wrong.
   */
  const ready = (t: ToolName) => {
    if (found.error) return true
    const d = found.data?.find((x) => x.name === t)
    return !!d && d.installed && d.loggedIn
  }
  const shown = tools.filter((t) => t.name === tool || ready(t.name))
  if (shown.length < 2) return null

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
    </div>
  )
}
