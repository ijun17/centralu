import { useEffect, useState } from 'react'
import type { HostActivity, MachineInfo } from '@cc/protocol'
import { autostartRow, hostStartNote, installNote, machineProblem, operationNote, updateStops, versionPrompt } from '@cc/core'
import { useStore } from '../../store/store.js'
import { MachineStatusMark } from '../machines/MachineTag.jsx'
import { AddMachineForm, SHELL_LABEL, withCode } from './AddMachineForm.jsx'

/**
 * Settings → Machines (#82, docs/plans/remote-hub.md): the other computers this computer's host reaches.
 *
 * The person arrives here with one of three errands: link a machine, find out why one is not connected, or decide
 * about versions that differ. So each row says its state, then its last error **as what to do** (core's
 * `machineProblem`: "run ssh-add", "ssh once in a terminal", "centralu is not installed there"), then the version
 * prompt when the link is held on versions. Adding one is the consent for this computer to reach it (plan §3.2): the
 * person can already open an ssh connection to it, and the link uses their own ssh and keys, never a password.
 */
export function MachinesSection({ onOpenCategory }: { onOpenCategory: (category: 'updates') => void }) {
  const machines = useStore((s) => s.machines)
  const list = Object.values(machines)
  const [adding, setAdding] = useState(list.length === 0)
  return (
    <section data-testid="settings-machines">
      <p className="text-xs leading-body text-ink-faint">
        Other computers whose sessions and projects show here, each under its own name in the sidebar. Each one runs
        Centralu itself (<code className="font-mono">centralu serve</code>); this computer reaches it over your own ssh
        and keys. Nothing is opened to the network.
      </p>
      {list.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="machines-list">
          {list.map((m) => (
            <MachineRow key={m.id} m={m} onOpenCategory={onOpenCategory} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddMachineForm onDone={() => setAdding(false)} canCancel={list.length > 0} />
      ) : (
        <button
          type="button"
          className="mt-3 rounded-md border border-line px-2 py-1 text-xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
          onClick={() => setAdding(true)}
          data-testid="machines-add-open"
        >
          Add a machine
        </button>
      )}
    </section>
  )
}

function MachineRow({ m, onOpenCategory }: { m: MachineInfo; onOpenCategory: (category: 'updates') => void }) {
  const reconnect = useStore((s) => s.reconnectMachine)
  const remove = useStore((s) => s.removeMachine)
  const setToast = useStore((s) => s.setToast)
  const [confirming, setConfirming] = useState(false)
  const problem = machineProblem(m)
  const started = hostStartNote(m)
  const operation = operationNote(m)
  const where = [m.sshTarget, SHELL_LABEL[m.shell], m.shell === 'wsl' ? m.wslDistro : null, m.command ? `runs ${m.command}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="rounded-md border border-line px-2.5 py-2" data-testid={`machine-row-${m.id}`} data-status={m.status}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-ink">{m.name}</span>
        <MachineStatusMark status={m.status} testId={`machine-row-status-${m.id}`} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {m.status !== 'connected' && !m.operation && (
            <button
              type="button"
              className="text-xs text-ink-faint hover:text-ink"
              onClick={() => void reconnect(m.id)}
              data-testid={`machine-reconnect-${m.id}`}
            >
              Reconnect
            </button>
          )}
          {confirming ? (
            <>
              <span className="text-xs text-ink-muted">Remove?</span>
              <button
                type="button"
                className="text-xs text-danger hover:text-ink"
                onClick={() =>
                  void remove(m.id).catch((e: Error) => {
                    setConfirming(false)
                    setToast(`Could not remove ${m.name}: ${e.message}`)
                  })
                }
                data-testid={`machine-remove-yes-${m.id}`}
              >
                Remove
              </button>
              <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-xs text-ink-faint hover:text-ink"
              onClick={() => setConfirming(true)}
              data-testid={`machine-remove-${m.id}`}
              title="Unlink it: its sessions and projects leave this computer's lists. Nothing on the machine changes."
            >
              Remove
            </button>
          )}
        </span>
      </div>
      <p className="mt-0.5 truncate font-mono text-2xs text-ink-faint" title={where}>
        {where}
      </p>
      {operation && (
        <p className="mt-1 text-xs leading-body text-ink" data-testid={`machine-operation-${m.id}`} data-step={m.operation?.step}>
          {operation}
        </p>
      )}
      <InstalledRow m={m} />
      <AutostartSwitch m={m} />
      {started && (
        <p className="mt-1 text-xs leading-body text-ink-muted" data-testid={`machine-started-${m.id}`} data-how={m.hostStarted?.how}>
          {started}
        </p>
      )}
      {confirming && (
        <p className="mt-1 text-xs leading-body text-ink-muted">
          Its sessions and projects leave this computer&apos;s lists. Nothing on {m.name} changes, and linking it again brings
          them back.
        </p>
      )}
      {problem && m.status !== 'versions_differ' && (
        <div className="mt-1.5 text-xs leading-body" data-testid={`machine-problem-${m.id}`}>
          <p className="text-ink">{problem.title}</p>
          {problem.fix && <p className="mt-0.5 text-ink-muted">{withCode(problem.fix)}</p>}
        </div>
      )}
      <VersionPrompt m={m} onOpenCategory={onOpenCategory} />
    </li>
  )
}

const linkButton = 'text-xs text-ink-faint hover:text-ink disabled:opacity-50'
const boxButton =
  'rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-50'

/**
 * A change that stops the host there (update, rollback), asked first with what it stops (plan §10.5): the remote's
 * own count of what is running, read when the question opens. Without a keeper on the remote its agents end; their
 * sessions resume on the version that starts.
 */
function StopConfirm({ m, action, onCancel, onConfirm }: { m: MachineInfo; action: string; onCancel: () => void; onConfirm: () => void }) {
  const machineActivity = useStore((s) => s.machineActivity)
  const [activity, setActivity] = useState<HostActivity | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void machineActivity(m.id).then((a) => live && setActivity(a))
    return () => {
      live = false
    }
  }, [machineActivity, m.id])
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-floor px-2.5 py-2" data-testid={`machine-stop-confirm-${m.id}`}>
      <p className="text-xs leading-body text-ink" data-testid={`machine-stop-text-${m.id}`}>
        {activity === undefined ? `Asking ${m.name} what is running…` : updateStops(m.name, activity).replace(/^Updating/, action)}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={boxButton} disabled={activity === undefined} onClick={onConfirm} data-testid={`machine-stop-yes-${m.id}`}>
          {action}
        </button>
        <button type="button" className={linkButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/**
 * What this computer installed there (plan §10.5): the version, roll back one step while an earlier one is kept, and
 * remove it. Install when nothing is there to run. Each answers when done; its steps show as the row's operation.
 */
function InstalledRow({ m }: { m: MachineInfo }) {
  const change = useStore((s) => s.changeMachineInstall)
  const [asking, setAsking] = useState<'rollback' | 'uninstall' | null>(null)
  const note = installNote(m)
  const busy = !!m.operation
  const notInstalled = !m.install?.current && !m.command && (m.status === 'not_running' || /not installed/i.test(m.error ?? ''))
  const hubVersion = m.versions?.hub
  if (notInstalled) {
    if (hubVersion?.dev) return null
    return (
      <div className="mt-1.5">
        <button type="button" className={boxButton} disabled={busy} onClick={() => void change(m.id, 'install')} data-testid={`machine-install-${m.id}`}>
          Install Centralu on {m.name}
        </button>
      </div>
    )
  }
  if (!note) return null
  const previous = m.install?.previous
  return (
    <div className="mt-1" data-testid={`machine-installed-${m.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs leading-body text-ink-muted">{note}</span>
        {previous && (
          <button type="button" className={linkButton} disabled={busy} onClick={() => setAsking('rollback')} data-testid={`machine-rollback-${m.id}`}>
            Roll back to {previous.version}
          </button>
        )}
        <button type="button" className={linkButton} disabled={busy} onClick={() => setAsking('uninstall')} data-testid={`machine-uninstall-${m.id}`}>
          Uninstall
        </button>
      </div>
      {asking === 'rollback' && (
        <StopConfirm
          m={m}
          action="Roll back"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null)
            void change(m.id, 'rollback')
          }}
        />
      )}
      {asking === 'uninstall' && (
        <div className="mt-2 rounded-md border border-line bg-surface-floor px-2.5 py-2" data-testid={`machine-uninstall-confirm-${m.id}`}>
          <p className="text-xs leading-body text-ink">
            This stops Centralu on {m.name}, and anything running there with it, and removes what this computer installed
            {m.autostart?.on ? ', and its start at boot' : ''}. Its conversations and settings stay, and so does a Centralu
            installed there with npm. {m.name} stays linked.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-line px-2 py-0.5 text-xs text-danger transition-colors hover:border-line-strong"
              onClick={() => {
                setAsking(null)
                void change(m.id, 'uninstall')
              }}
              data-testid={`machine-uninstall-yes-${m.id}`}
            >
              Uninstall
            </button>
            <button type="button" className={linkButton} onClick={() => setAsking(null)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Start at boot (plan §10.4, owner decision 4): per machine, off by default. The Centralu there writes its own entry (a
 * systemd user unit, a Windows scheduled task at sign-in); nothing starts or stops now, so nothing is asked first. The
 * switch shows what the machine answered: it moves when the row does, not when it is clicked.
 */
function AutostartSwitch({ m }: { m: MachineInfo }) {
  const setAutostart = useStore((s) => s.setMachineAutostart)
  const [pending, setPending] = useState(false)
  const row = autostartRow(m)
  if (!row) return null
  return (
    <div className="mt-1.5">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-ink-muted">
        <input
          type="checkbox"
          className="accent-ink-muted"
          checked={row.on}
          disabled={pending || !!m.operation}
          onChange={(e) => {
            const on = e.target.checked
            setPending(true)
            void setAutostart(m.id, on).finally(() => setPending(false))
          }}
          data-testid={`machine-autostart-${m.id}`}
        />
        <span>{row.label}</span>
      </label>
      {row.note && (
        <p className="mt-0.5 text-xs leading-body text-ink-faint" data-testid={`machine-autostart-note-${m.id}`}>
          {withCode(row.note)}
        </p>
      )}
    </div>
  )
}

/**
 * The version prompt (plan §4): bring the older side up to the newer one, and connect anyway when both speak one
 * protocol. An older remote is updated from here (plan §10.5) after the person read what that stops there; where this
 * computer cannot (a development build, a command of the person's own), the exact command to run there is given.
 */
function VersionPrompt({ m, onOpenCategory }: { m: MachineInfo; onOpenCategory: (category: 'updates') => void }) {
  const accept = useStore((s) => s.acceptMachineVersions)
  const update = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const change = useStore((s) => s.changeMachineInstall)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const p = versionPrompt(m)
  if (!p) return null
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-raised px-2.5 py-2" data-testid={`machine-versions-${m.id}`}>
      <p className="text-xs leading-body text-ink" data-testid={`machine-versions-text-${m.id}`}>
        {p.text}
      </p>
      {p.older === 'hub' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* The same door as Settings → Updates: npm, then a relaunch that keeps agents running */}
          <button
            type="button"
            className="rounded-md border border-line px-2 py-0.5 text-xs text-ink transition-colors hover:border-line-strong"
            onClick={() => void (update?.newer ? applyUpdate() : checkUpdate(true))}
            data-testid={`machine-update-hub-${m.id}`}
          >
            {update?.newer && update.latest ? `Update this computer to ${update.latest}` : 'Check for an update'}
          </button>
          <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={() => onOpenCategory('updates')}>
            Open Updates
          </button>
        </div>
      )}
      {p.updateHere && !confirming && (
        <div className="mt-2">
          <button
            type="button"
            className={boxButton}
            disabled={!!m.operation}
            onClick={() => setConfirming(true)}
            data-testid={`machine-update-remote-${m.id}`}
          >
            Update {m.name} to {p.target}
          </button>
        </div>
      )}
      {p.updateHere && confirming && (
        <StopConfirm
          m={m}
          action="Update"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void change(m.id, 'update')
          }}
        />
      )}
      {p.remoteCommand && !p.updateHere && (
        <div className="mt-2">
          <p className="text-xs leading-body text-ink-muted">
            This computer cannot update {m.name} from here. On {m.name}, run this, then restart{' '}
            <code className="font-mono">{p.centralu} serve</code>:
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-floor px-2 py-1 font-mono text-xs text-ink"
              data-testid={`machine-update-command-${m.id}`}
            >
              {p.remoteCommand}
            </code>
            <button
              type="button"
              className="shrink-0 text-xs text-ink-faint hover:text-ink"
              onClick={() =>
                void navigator.clipboard?.writeText(p.remoteCommand!).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {!p.held ? null : p.compatible ? (
        <button
          type="button"
          className="mt-2 rounded-md border border-line px-2 py-0.5 text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          onClick={() => void accept(m.id)}
          data-testid={`machine-accept-versions-${m.id}`}
          title="Connect without aligning. Asked again when either side changes version."
        >
          Connect anyway
        </button>
      ) : (
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid={`machine-versions-refused-${m.id}`}>
          Machines on different protocol versions cannot connect, even anyway.
        </p>
      )}
    </div>
  )
}
