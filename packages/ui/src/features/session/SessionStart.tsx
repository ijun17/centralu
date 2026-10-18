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
    <div className="mx-auto w-full max-w-[560px] px-4 pt-6" data-testid="session-start">
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
  if (tools.length < 2) return null

  const status = (t: ToolName) => found.data?.find((x) => x.name === t)
  // Unknown (not answered yet, or the question failed) is not "unusable": the button stays live, as the dialog's do
  const usable = (t: ToolName) => {
    const d = status(t)
    return !d || (d.installed && d.loggedIn)
  }

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

  /*
   * Why a tool cannot be picked, said in words beside the buttons (owner, 2026-10-18: Codex looked broken on a linked
   * machine where it was not installed). A disabled button's tooltip barely shows, so the title alone left no reason.
   */
  const where = machine ? ` on ${machine}` : ''
  const blocked = tools
    .filter((t) => t.name !== tool && !usable(t.name))
    .map((t) => {
      // Only a tool the machine answered for is blocked (`usable`), so its answer is there
      const d = status(t.name)!
      return d.installed
        ? `${t.label} needs a login${where}: ${d.login}`
        : `${t.label} is not installed${where}: ${d.install}`
    })

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5" role="radiogroup" aria-label="Tool" data-testid="session-start-tools">
        {tools.map((t) => {
          const on = t.name === tool
          const d = status(t.name)
          const why = usable(t.name)
            ? undefined
            : d?.installed
              ? `${t.label} needs a login`
              : `${t.label} is not installed`
          return (
            <button
              key={t.name}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy !== null || (!on && !usable(t.name))}
              onClick={() => void pick(t.name)}
              title={why}
              data-testid={`session-start-tool-${t.name}`}
              className={`rounded-md border px-2.5 py-1 text-sm transition-colors disabled:cursor-default ${
                on
                  ? 'border-ink-muted bg-surface-hover/40 text-ink'
                  : 'border-line text-ink-muted hover:border-line-strong hover:text-ink disabled:opacity-50 disabled:hover:border-line disabled:hover:text-ink-muted'
              }`}
            >
              {busy === t.name ? 'Switching…' : t.label}
            </button>
          )
        })}
      </div>
      {blocked.map((line) => (
        <p key={line} className="text-xs text-ink-faint" data-testid="session-start-tool-blocked">
          {line}
        </p>
      ))}
    </div>
  )
}
