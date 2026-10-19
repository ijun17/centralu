import type { DragEvent, ReactNode } from 'react'
import type { SessionSummary } from '@cc/core'
import { formatClock } from '../../app/format.js'
import { useStore } from '../../store/store.js'
import { CrownIcon, RestartIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { RunMenu } from './RunMenu.jsx'
import { BackgroundTasksBadge } from './BackgroundTasks.jsx'
import { AgentVersionNotice } from './AgentVersionNotice.jsx'
import { SessionMachineTag } from '../machines/MachineTag.jsx'
import { PresetTag } from './PresetTag.jsx'
import { SubagentSteps } from './chat-rows/ChatRow.jsx'
import { AskedByBadge } from './chat-rows/delegation.jsx'

/**
 * A session pane's header (#428): the name, the machine, the badges, Run and Restart.
 *
 * The focus view's title bar and the grid panel's handle are both this row; which one it is
 * comes from `headerDrag` (see SessionPane, which also holds `runOpen`).
 */
export function SessionHeader({
  session,
  projectRoot,
  runOpen,
  setRunOpen,
  headerExtra,
  headerDrag,
}: {
  session: SessionSummary
  projectRoot: string | null
  runOpen: boolean
  setRunOpen: (open: boolean) => void
  headerExtra?: ReactNode
  headerDrag?: (e: DragEvent<HTMLElement>) => void
}) {
  const restart = useStore((s) => s.restartSession)
  // Whether the process is being swapped out (the same lock as wake/fork) — the basis for the
  // button spinning and locking
  const restarting = useStore((s) => !!s.resuming[session.id])

  /*
   * The header's height is written as **an explicit height**, not padding (2026-09-13).
   *
   * The value is back to 40px — 32px and 36px were both tried and reverted. What changed is how
   * it is written: writing it as py-2 lets the height be dictated by the tallest thing inside it
   * (the tool button row at 23px), and the evidence panel header standing next to it had 24px
   * inside it, coming out to 41px — **a 1px mismatch.** Two rows standing side by side show a
   * doubled edge from even a 1px difference. With both at h-10, that gap never has a chance to
   * appear.
   */
  const HEADER = 'flex h-10 items-center gap-2.5 border-b border-line px-4'
  const header = (
    <>
      {/*
        A status dot is already told by the sidebar's tool marker and the grid's
        while-responding border. A tiny dot is barely visible while saying the same thing a
        third time, so it is left out of the header. Only the orchestrator gets a crown to the
        left of its title, marking not status but a **role**.
      */}
      {session.kind === 'orchestrator' && (
        <span className="flex shrink-0 text-ink-muted" data-testid="session-header-crown">
          <CrownIcon size={14} />
        </span>
      )}
      <h1 className="truncate text-md font-medium text-ink" data-testid="session-name">
        {session.name}
      </h1>

      {/*
        The machine it runs on (#82). This header is also every grid panel's, and the conversation under it is where an
        approval or a question is answered, so all three say which machine they act on.
      */}
      <SessionMachineTag sessionId={session.id} testId="session-machine" />
      {/* Started from a linked computer (#1273): the preset it runs under, on both computers */}
      <PresetTag preset={session.permissionPreset} startedFromHub={session.startedFromHub} testId="session-preset" />

      {/* Another project's session asked for this one (#371) — the way back to it */}
      {session.askedBy && <AskedByBadge callerId={session.askedBy} projectId={session.projectId ?? null} />}

      {session.limit && (
        <span className="readout text-xs text-ink-muted" data-testid="limit-badge">
          Limit {session.limit.usedPercent != null ? `${session.limit.usedPercent}%` : 'reached'}
          {session.limit.resumeAt
            ? ` · resets ${formatClock(new Date(session.limit.resumeAt))}`
            : ''}
        </span>
      )}

      {/*
        A goal that is set (2026-09-07 — Claude's /goal, Codex's thread/goal/*). What a session
        running a goal cares about is "when does this end", so this carries a factual summary
        (iteration count, status) rather than the full condition text, and leaves the full text
        and the reason it fell short to the hover. It disappears once cleared, including on
        success.
      */}
      {session.goal && (
        <span
          className="readout shrink-0 rounded-md border border-line px-1.5 text-2xs text-ink-muted"
          data-testid="goal-badge"
          title={`${session.goal.objective}${session.goal.reason ? `\n\n${session.goal.reason}` : ''}`}
        >
          GOAL
          {session.goal.iterations != null ? ` · ${session.goal.iterations}` : ''}
          {session.goal.status !== 'active' ? ` · ${session.goal.status}` : ''}
        </span>
      )}

      {/*
        The agent's background work (#290): how many tasks run behind the turn, opening the list with a stop per task,
        and the ones that ended with how they ended. An agent's row opens the same recorded steps (#222) its launch
        card does.
      */}
      <BackgroundTasksBadge
        sessionId={session.id}
        tasks={session.backgroundTasks}
        renderSteps={(callId) => (
          <SubagentSteps sessionId={session.id} callId={callId} projectRoot={projectRoot} projectId={session.projectId} />
        )}
      />

      {/* The agent CLI installed is newer than the one this session's process runs (#297) */}
      <AgentVersionNotice session={session} />

      {/*
        Stop is not placed here — it already sits next to "waiting for a response" at the
        bottom of the conversation. Having a button that does the same thing at each end of the
        screen would mean checking every time which one is which.
      */}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {/*
          The project's saved shell commands (issue #44). Before restart because it is the
          everyday one — restart is a repair.

          The orchestrator has no project, and with no project there is no directory to run
          in and no terminal to run it in. So it gets no button rather than an empty menu:
          an entry that could never have anything in it is a worse answer than no entry.
        */}
        {session.projectId && <RunMenu projectId={session.projectId} open={runOpen} onOpenChange={setRunOpen} />}
        {/* Creating a new session when the tool locks up would cut off context — this swaps
        only the process */}
        {/*
          **The icon spins and the button locks** while this is pressed.
          It takes a few seconds, and a quiet screen would invite a second press, which
          would kill the process that just started — the button meant to fix things would
          cause the failure. The lock lives in the store (resuming): whether it is still
          running belongs to the session, not to this component, even as the screen switches
          between the grid and the focus view.
        */}
        <IconButton
          label={restarting ? 'Restarting the agent…' : 'Restart agent (chat history is kept)'}
          onClick={() => void restart(session.id)}
          disabled={restarting}
          testId="restart-session"
          align="right"
        >
          <span
            className={restarting ? 'cc-spin block' : 'block'}
            data-testid={restarting ? 'restart-spinning' : undefined}
          >
            <RestartIcon />
          </span>
        </IconButton>
        {headerExtra}
      </span>
    </>
  )

  return headerDrag ? (
    <div
      className={`${HEADER} cursor-grab active:cursor-grabbing`}
      // Not while the Run menu is open — see the note on `runOpen`
      draggable={!runOpen}
      onDragStart={headerDrag}
      data-testid="pane-header"
    >
      {header}
    </div>
  ) : (
    <DragRegion className={HEADER} testId="pane-header">
      {header}
    </DragRegion>
  )
}
