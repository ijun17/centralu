import { useEffect, useState } from 'react'
import { machineProblem } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { ActionRow } from './ActionRow.jsx'
import { connectAction } from '../../settings/MachinesSection.jsx'

/**
 * Reconnect, first in the menu of a project whose machine is not connected (#1533). The person finds the project, not the
 * machine: its menu is where they look for a way to bring it back, and the badge's menu and Settings → Machines were two
 * clicks away. It is the same action as theirs (`reconnectMachine`, so `machines.reconnect`: one attempt now, skipping the
 * backoff), and the host joins a press and an agent's call at the same moment into one attempt.
 *
 * It says what it is doing: "Connecting…" while the attempt is under way, with the menu left open; connected, the menu
 * closes (the row is gone, there is nothing left to press); failed, the row is back with the reason in plain words under it
 * (the words Settings → Machines uses for the same state), ready to be pressed again. Hidden while the machine is connected.
 */
export function ReconnectRow({ machine, projectName, onClose }: { machine: string; projectName: string; onClose: () => void }) {
  const info = useStore((s) => s.machines[machine])
  /*
   * `asking` is the time between the press and the host's answer: its answer already carries the row as `connecting`, but the
   * state that was there before the press (with its old error) is what the store holds until then, and must not read as this
   * press's failure. `asked` is a press whose answer came, so what the row says now is what the attempt came to.
   */
  const [pressed, setPressed] = useState<'no' | 'asking' | 'asked'>('no')
  const status = info?.status
  useEffect(() => {
    if (pressed !== 'no' && status === 'connected') onClose()
  }, [pressed, status, onClose])
  if (!info || status === 'connected') return null
  // An install, update or rollback is under way there: Settings → Machines hides Connect then, and so does the badge's menu
  const busy = !!info.operation
  const trying = pressed === 'asking' || status === 'connecting' || status === 'starting' || status === 'updating'
  const action = connectAction(status ?? 'unreachable')
  const problem = pressed === 'asked' && !trying ? machineProblem(info) : null
  return (
    <>
      <ActionRow
        label={trying ? 'Connecting…' : action.label}
        title={busy ? 'Wait for the change under way there to finish' : trying ? undefined : action.title}
        disabled={trying || busy}
        onClick={() => {
          setPressed('asking')
          void useStore.getState().reconnectMachine(machine).finally(() => setPressed('asked'))
        }}
        testId={`reconnect-${projectName}`}
      />
      {problem && (
        <div className="px-2 pb-1.5 text-xs leading-body text-ink-muted" role="status" data-testid={`reconnect-result-${projectName}`}>
          Could not connect: {problem.title}
          {problem.fix ? `. ${problem.fix}` : ''}
        </div>
      )}
      <div className="my-1 border-t border-line" />
    </>
  )
}
