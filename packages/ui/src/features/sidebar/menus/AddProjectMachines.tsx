import { useStore } from '../../../store/store.js'
import { MachineStatusMark } from '../../machines/MachineStatusMark.jsx'
import { RowMenu } from './RowMenu.jsx'
import { ActionRow } from './ActionRow.jsx'

/**
 * Where Add project adds the folder, once a machine is linked (#734): this computer (the folder picker), or a linked
 * machine (its path typed in AddRemoteProjectDialog, or a new folder made there). It took the place of each machine
 * header's +. A machine that is not connected is listed but cannot be picked, since that machine's host is the one that
 * checks the path; its state says why, in the words the header used.
 */
export function AddProjectMachines({
  machines,
  anchorEl,
  onClose,
  onPick,
}: {
  machines: string[]
  anchorEl: HTMLElement | null
  onClose: () => void
  /** null: this computer */
  onPick: (machine: string | null) => void
}) {
  const info = useStore((s) => s.machines)
  return (
    <RowMenu anchorEl={anchorEl} testId="add-project-machines" onClose={onClose}>
      <ActionRow label="This computer" onClick={() => onPick(null)} testId="add-project-on-local" />
      {machines.map((m) => {
        const machine = info[m]
        const name = machine?.name ?? m
        const connected = machine?.status === 'connected'
        return (
          <ActionRow
            key={m}
            label={name}
            onClick={() => onPick(m)}
            testId={`add-project-on-${m}`}
            disabled={!connected}
            title={connected ? `Add a project on ${name}` : `${name} is not connected`}
            trailing={machine && <MachineStatusMark status={machine.status} testId={`add-project-status-${m}`} />}
          />
        )
      })}
    </RowMenu>
  )
}
