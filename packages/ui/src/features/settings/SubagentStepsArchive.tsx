import type { SubagentStepsHeld, TrashedSubagentSteps } from '@cc/protocol/client'
import { formatBytes, formatCount, formatDay } from '../../app/format.js'
import { Button } from '../../components/Button.jsx'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { SettingsCard, SettingsEmpty } from './SettingsLayout.jsx'

/**
 * A session's subagent steps in Settings → Archive (#418): what each live session's steps take, with the way to move them
 * to the session archive while the session stays, and a trashed set of steps as a row of the session archive.
 *
 * The steps of the native subagents a session launched (#222) are kept under their launch cards and read only when a
 * card is opened, so nothing showed what they took: the measured store held 46 MB of them, all one session still in use,
 * and the only way to let them go was to delete the conversation. The session archive is where this screen says what the store
 * holds, so they are said here.
 *
 * The list of what sessions hold is drawn in the shared Settings card (owner, 2026-10-31), its action the shared `Button`; a trashed set of steps
 * is a row of the session archive list, drawn as the archived sessions beside it are.
 */

/** A count and its noun, the count through the shared formatter (`formatCount`): "1 run", "1.2k steps" */
export const stepsCount = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`

/** "2 runs · 1.2k steps · 46.2 MB": what a session's subagent steps take */
export function stepsTake(s: Pick<SubagentStepsHeld, 'runs' | 'steps' | 'bytes'>): string {
  return `${stepsCount(s.runs, 'run', 'runs')} · ${stepsCount(s.steps, 'step', 'steps')} · ${formatBytes(s.bytes)}`
}

/** The refusal a row may be showing, and whether an action is running */
type RowState = {
  busy: boolean
  error: string | null
}

/**
 * What each live session's subagent steps take, largest first, each with "Archive": at once, with Undo on the toast (#1512). `sessions` null while it is
 * read; `error` when reading it failed. `unreached`: linked machines whose sessions could not be read (#841's rule), each
 * named; with one, the list is never said to be empty, since it is not the whole of it.
 */
export function SubagentStepsHeldList({
  sessions,
  unreached = [],
  error,
  onRetry,
  row,
  onMove,
}: {
  sessions: readonly SubagentStepsHeld[] | null
  unreached?: readonly { machineId: string; name: string }[]
  error: string | null
  onRetry: () => void
  row: (sessionId: string) => RowState
  onMove: (s: SubagentStepsHeld) => void
}) {
  return (
    <section data-testid="subagent-steps-held">
      <div className="px-1">
        <h3 className="text-xs font-medium text-ink-muted">Subagent steps in sessions</h3>
        <p className="mt-0.5 text-xs leading-body text-ink-faint">
          What the agents a session launched did, kept under their cards in the conversation. Moving them to the session archive
          frees the space and keeps the conversation; the cards then say where the steps went.
        </p>
      </div>
      {error ? (
        <LoadFailed what="what subagent steps take" error={error} onRetry={onRetry} className="mt-2" testId="subagent-steps-held-error" />
      ) : sessions === null ? (
        <SettingsCard className="mt-2">
          <SettingsEmpty>Loading…</SettingsEmpty>
        </SettingsCard>
      ) : sessions.length === 0 && unreached.length === 0 ? (
        <SettingsCard className="mt-2">
          <SettingsEmpty testId="subagent-steps-held-empty">No session keeps subagent steps</SettingsEmpty>
        </SettingsCard>
      ) : sessions.length === 0 ? null : (
        <SettingsCard as="ul" className="mt-2" testId="subagent-steps-held-list">
          {[...sessions]
            .sort((a, b) => b.bytes - a.bytes)
            .map((s) => {
              const r = row(s.sessionId)
              return (
                <li key={s.sessionId} className="px-4 py-2.5" data-testid={`subagent-steps-held-${s.sessionId}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm text-ink">{s.name}</span>
                    <span className="min-w-0 shrink truncate text-2xs text-ink-muted">{s.project ? s.project.name : 'No project'}</span>
                    <Button
                      variant="quiet"
                      size="sm"
                      className="ml-auto shrink-0"
                      disabled={r.busy}
                      onClick={() => onMove(s)}
                      data-testid={`subagent-steps-move-${s.sessionId}`}
                    >
                      Archive
                    </Button>
                  </div>
                  <div className="readout mt-0.5 text-2xs text-ink-faint" data-testid={`subagent-steps-take-${s.sessionId}`}>
                    {stepsTake(s)}
                  </div>
                  {r.error && (
                    <p className="mt-1.5 text-xs leading-body text-ink" data-testid={`subagent-steps-error-${s.sessionId}`}>
                      {r.error}
                    </p>
                  )}
                </li>
              )
            })}
        </SettingsCard>
      )}
      {unreached.map((m) => (
        <p key={m.machineId} className="mt-2 text-xs leading-body text-ink" data-testid={`subagent-steps-unreached-${m.machineId}`}>
          {m.name}: its sessions could not be read just now, so their subagent steps are not listed.
        </p>
      ))}
    </section>
  )
}

/** A session's subagent steps in the session archive: a row of the session archive list, with Restore and Delete for good */
export function TrashedSubagentStepsRow({
  entry: s,
  busy,
  confirming,
  error,
  onRestore,
  onAskPurge,
  onPurge,
  onCancel,
}: {
  entry: TrashedSubagentSteps
  busy: boolean
  confirming: boolean
  error: string | null
  onRestore: () => void
  onAskPurge: () => void
  onPurge: () => void
  onCancel: () => void
}) {
  return (
    <li className="px-4 py-3" data-testid={`trash-steps-row-${s.sessionId}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm text-ink">Subagent steps of {s.name}</span>
        <span className="min-w-0 shrink truncate text-2xs text-ink-muted">{s.project ? s.project.name : 'No project'}</span>
        <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">{formatDay(s.deletedAt)}</span>
      </div>
      <div className="mt-0.5 text-2xs text-ink-faint" data-testid={`trash-steps-holds-${s.sessionId}`}>
        {stepsTake(s)} · the session stays
      </div>
      <div className="mt-1.5 flex gap-3 text-xs">
        <button
          type="button"
          className="text-ink-faint hover:text-ink disabled:opacity-50"
          disabled={busy}
          onClick={onRestore}
          data-testid={`trash-steps-restore-${s.sessionId}`}
        >
          Restore
        </button>
        <button
          type="button"
          className="text-ink-faint hover:text-danger disabled:opacity-50"
          disabled={busy}
          onClick={onAskPurge}
          data-testid={`trash-steps-purge-${s.sessionId}`}
        >
          Delete for good…
        </button>
      </div>
      {error && (
        <p className="mt-1.5 text-xs leading-body text-ink" data-testid={`trash-steps-error-${s.sessionId}`}>
          {error}
        </p>
      )}
      {confirming && (
        <InlineConfirm
          text={`Delete the subagent steps of “${s.name}” for good? ${stepsCount(s.steps, 'step leaves', 'steps leave')} this computer; the session and its conversation stay. This cannot be undone.`}
          yesLabel="Delete for good"
          tone="danger"
          busy={busy}
          onYes={onPurge}
          onNo={onCancel}
          testId="trash-confirm"
        />
      )}
    </li>
  )
}
