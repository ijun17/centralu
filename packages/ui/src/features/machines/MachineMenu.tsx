import { useStore } from '../../store/store.js'
import { RelativeAge } from '../../components/RelativeAge.jsx'
import { RowMenu } from '../sidebar/menus/RowMenu.jsx'
import { ActionRow } from '../sidebar/menus/ActionRow.jsx'
import { MachineStatusMark } from './MachineStatusMark.jsx'

/**
 * What the sidebar's machine badge opens (owner, 2026-10-20): the link's state where the badge is, and Connect beside
 * it, so a project whose machine dropped is brought back from its own line rather than from Settings. The state, the
 * link's last error and when it was last connected are read here; the switches stay in Settings → Machines, one row away.
 */
export function MachineMenu({ machine, anchorEl, onClose }: { machine: string; anchorEl: HTMLElement | null; onClose: () => void }) {
  const info = useStore((s) => s.machines[machine])
  const reconnect = useStore((s) => s.reconnectMachine)
  const disconnect = useStore((s) => s.disconnectMachine)
  const openSettingsAt = useStore((s) => s.openSettingsAt)
  const name = info?.name ?? machine
  const status = info?.status ?? 'unreachable'
  const connected = status === 'connected'
  // An attempt under way: Connect would only start the same one again
  const trying = status === 'connecting' || status === 'starting' || status === 'updating'
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`machine-menu-${machine}`} onClose={onClose} className="w-64">
      <div className="flex flex-col gap-1 px-2 pb-2 pt-1.5">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">{name}</span>
          <MachineStatusMark status={status} testId={`machine-menu-status-${machine}`} />
        </span>
        {info?.sshTarget && <span className="readout truncate text-2xs text-ink-faint">{info.sshTarget}</span>}
        {!connected && info?.error && (
          <span className="text-xs leading-body text-ink-muted" data-testid={`machine-menu-error-${machine}`}>
            {info.error}
          </span>
        )}
        {!connected && (
          <span className="text-2xs text-ink-faint">
            {info?.lastConnectedAt ? (
              <>
                Last connected <RelativeAge when={info.lastConnectedAt} />
              </>
            ) : (
              'Has not connected since Centralu started'
            )}
          </span>
        )}
      </div>
      <div className="border-t border-line pt-1">
        {connected ? (
          <ActionRow label="Disconnect" onClick={pick(() => void disconnect(machine))} testId={`machine-menu-disconnect-${machine}`} />
        ) : (
          <ActionRow
            label={trying ? 'Connecting…' : 'Connect'}
            onClick={pick(() => void reconnect(machine))}
            disabled={trying}
            testId={`machine-menu-connect-${machine}`}
          />
        )}
        <ActionRow label="Machine settings" onClick={pick(() => openSettingsAt('machines'))} testId={`machine-menu-settings-${machine}`} />
      </div>
    </RowMenu>
  )
}
