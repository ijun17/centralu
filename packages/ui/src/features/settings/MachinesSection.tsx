import { useState } from 'react'
import type { HostActivity, MachineAskConsent, MachineInfo } from '@cc/protocol'
import {
  asksRow,
  autostartRow,
  updateWaits,
  elevatedNote,
  followHubLead,
  followHubNote,
  hostStartNote,
  installNote,
  logonNote,
  machineProblem,
  operationNote,
  updateStops,
  versionPrompt,
} from '@cc/core'
import { useStore } from '../../store/store.js'
import { InlineConfirm } from '../../components/InlineConfirm.jsx'
import { Button } from '../../components/Button.jsx'
import { MachineStatusMark } from '../machines/MachineStatusMark.jsx'
import { AwayNote } from '../machines/AwayNote.jsx'
import { AddMachineForm, SHELL_LABEL, withCode } from './AddMachineForm.jsx'
import { useLoad } from '../../app/useLoad.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { GrantList } from './GrantList.jsx'
import { Switch } from '../../components/Switch.jsx'
import { More, SettingsCard, SettingsPage, SettingsRow } from './SettingsLayout.jsx'

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
  // Automatic updates cover the linked machines too (#1508): each one on an older release follows this computer's version
  const follows = followHubLead(useStore((s) => s.update?.autoApply === true))
  const list = Object.values(machines)
  const [adding, setAdding] = useState(list.length === 0)
  return (
    <SettingsPage
      testId="settings-machines"
      title="Machines"
      lead={
        <>
          Other computers reached over your own ssh and keys. Nothing is opened to the network.
          <More>
            Their sessions and projects show here, each under its own name in the sidebar. Each one runs Centralu itself
            (<code className="font-mono">centralu serve</code>); this computer reaches it over your own ssh and keys.
          </More>
          {follows && (
            <span className="mt-1 block" data-testid="machines-follow-hub">
              {follows}
            </span>
          )}
        </>
      }
    >
      {list.length > 0 && (
        <ul className="space-y-3" data-testid="machines-list">
          {list.map((m) => (
            <MachineRow key={m.id} m={m} onOpenCategory={onOpenCategory} />
          ))}
        </ul>
      )}
      {adding ? (
        <AddMachineForm onDone={() => setAdding(false)} canCancel={list.length > 0} />
      ) : (
        <Button variant="quiet" size="sm" onClick={() => setAdding(true)} data-testid="machines-add-open">
          Add a machine
        </Button>
      )}
    </SettingsPage>
  )
}

/**
 * The row's button that opens the link (`machines.reconnect`): Connect for a disconnected machine (#1134), Start where
 * Centralu is stopped (#1143), which this computer then starts there, Reconnect otherwise
 */
export function connectAction(status: MachineInfo['status']): { label: string; title?: string } {
  if (status === 'disconnected') return { label: 'Connect', title: 'Stays connected until you disconnect it' }
  if (status === 'stopped') return { label: 'Start', title: 'Starts Centralu there, which this computer does not do by itself' }
  return { label: 'Reconnect' }
}

function MachineRow({ m, onOpenCategory }: { m: MachineInfo; onOpenCategory: (category: 'updates') => void }) {
  const reconnect = useStore((s) => s.reconnectMachine)
  const disconnect = useStore((s) => s.disconnectMachine)
  const remove = useStore((s) => s.removeMachine)
  const setToast = useStore((s) => s.setToast)
  const cancelUpdate = useStore((s) => s.cancelMachineUpdate)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const problem = machineProblem(m)
  const started = hostStartNote(m)
  const operation = operationNote(m)
  const followFailed = followHubNote(m)
  const elevated = elevatedNote(m)
  const logon = logonNote(m)
  const where = [m.sshTarget, SHELL_LABEL[m.shell], m.shell === 'wsl' ? m.wslDistro : null, m.command ? `runs ${m.command}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <SettingsCard as="li" testId={`machine-row-${m.id}`} data-status={m.status}>
      <div className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{m.name}</span>
          <MachineStatusMark status={m.status} testId={`machine-row-status-${m.id}`} />
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {m.status !== 'connected' && !m.operation && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void reconnect(m.id)}
                data-testid={`machine-reconnect-${m.id}`}
                title={connectAction(m.status).title}
              >
                {connectAction(m.status).label}
              </Button>
            )}
            {m.status !== 'disconnected' && !m.operation && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void disconnect(m.id)}
                data-testid={`machine-disconnect-${m.id}`}
                title="Its sessions keep running there"
              >
                Disconnect
              </Button>
            )}
            {confirming ? (
              <InlineConfirm
                inline
                text="Remove?"
                yesLabel="Remove"
                noLabel="Keep"
                busy={removing}
                onYes={() => {
                  setRemoving(true)
                  void remove(m.id).catch((e: Error) => {
                    setRemoving(false)
                    setConfirming(false)
                    setToast(`Could not remove ${m.name}: ${e.message}`)
                  })
                }}
                onNo={() => setConfirming(false)}
                yesTestId={`machine-remove-yes-${m.id}`}
              />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(true)}
                data-testid={`machine-remove-${m.id}`}
                title="Unlink it: its sessions and projects leave this computer's lists. Nothing on the machine changes."
              >
                Remove
              </Button>
            )}
          </span>
        </div>
        <p className="mt-0.5 truncate font-mono text-2xs text-ink-faint" title={where}>
          {where}
        </p>
        {operation && (
          <p className="mt-1.5 text-xs leading-body text-ink" data-testid={`machine-operation-${m.id}`} data-step={m.operation?.step}>
            {operation}
            {(m.operation?.step === 'wait_idle' || m.operation?.step === 'wait_unread') && (
              <>
                {' '}
                <Button variant="ghost" size="sm" onClick={() => void cancelUpdate(m.id)} data-testid={`machine-update-cancel-${m.id}`}>
                  Cancel
                </Button>
              </>
            )}
          </p>
        )}
        {followFailed && !m.operation && (
          <p className="mt-1.5 text-xs leading-body text-ink-muted" data-testid={`machine-follow-failed-${m.id}`}>
            {followFailed}
          </p>
        )}
        {elevated && (
          <div className="mt-1.5 text-xs leading-body" data-testid={`machine-elevated-${m.id}`}>
            <p className="text-ink">{elevated.title}</p>
            <p className="mt-0.5 text-ink-muted">{elevated.fix}</p>
          </div>
        )}
        {logon && (
          <div className="mt-1.5 text-xs leading-body" data-testid={`machine-logon-${m.id}`}>
            <p className="text-ink">{logon.title}</p>
            <p className="mt-0.5 text-ink-muted">{logon.fix}</p>
          </div>
        )}
        {started && (
          <p className="mt-1.5 text-xs leading-body text-ink-muted" data-testid={`machine-started-${m.id}`} data-how={m.hostStarted?.how}>
            {started}
          </p>
        )}
        {confirming && (
          <p className="mt-1.5 text-xs leading-body text-ink-muted">
            Its sessions and projects leave this computer&apos;s lists. Nothing on {m.name} changes, and linking it again brings
            them back.
          </p>
        )}
        {problem && m.status !== 'versions_differ' && (
          <div className="mt-1.5 text-xs leading-body" data-testid={`machine-problem-${m.id}`}>
            {/* A machine that is away is in a state, not in error: the title is in the ink of a note */}
            <p className={m.status === 'away' ? 'text-ink-muted' : 'text-ink'}>{problem.title}</p>
            {problem.fix && <p className="mt-0.5 text-ink-muted">{withCode(problem.fix)}</p>}
            <AwayNote m={m} testId={`machine-away-${m.id}`} />
          </div>
        )}
        <VersionPrompt m={m} onOpenCategory={onOpenCategory} />
      </div>
      <InstalledRow m={m} />
      <AutoReconnectSwitch m={m} />
      <AutostartSwitch m={m} />
      <AsksSwitch m={m} />
      <HubAutoSwitch m={m} />
    </SettingsCard>
  )
}

/**
 * A change that stops the host there (update, rollback), asked first with what it stops (plan §10.5): the remote's
 * own count of what is running, read when the question opens. Without a keeper on the remote its agents end; their
 * sessions resume on the version that starts.
 */
function StopConfirm({ m, action, onCancel, onConfirm }: { m: MachineInfo; action: string; onCancel: () => void; onConfirm: (when?: 'idle' | 'now') => void }) {
  const machineActivity = useStore((s) => s.machineActivity)
  /*
   * Undefined while the machine is being asked. A failed question reads as an unknown answer (null), which the
   * sentence words as such: it used to leave the confirmation asking, with its button disabled, for good.
   */
  const asked = useLoad(() => machineActivity(m.id), [machineActivity, m.id])
  const activity: HostActivity | null | undefined = asked.error !== null ? null : asked.data
  // An update with sessions in a turn there waits for them (#1399); stopping them is a second, plain choice
  const waits = action === 'Update' && activity !== undefined ? updateWaits(m.name, activity, m.updateWaits) : null
  return (
    <div className="space-y-1">
      <InlineConfirm
        text={activity === undefined ? `Asking ${m.name} what is running…` : (waits ?? updateStops(m.name, activity).replace(/^Updating/, action))}
        yesLabel={waits ? 'Update when idle' : action}
        busy={activity === undefined}
        onYes={() => onConfirm(waits ? 'idle' : undefined)}
        onNo={onCancel}
        testId={`machine-stop-confirm-${m.id}`}
        yesTestId={`machine-stop-yes-${m.id}`}
        textTestId={`machine-stop-text-${m.id}`}
      />
      {waits && (
        <Button variant="ghost" size="sm" onClick={() => onConfirm('now')} data-testid={`machine-stop-now-${m.id}`}>
          Update now, stopping them
        </Button>
      )}
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
      <div className="px-4 py-3">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void change(m.id, 'install')} data-testid={`machine-install-${m.id}`}>
          Install Centralu on {m.name}
        </Button>
      </div>
    )
  }
  if (!note) return null
  const previous = m.install?.previous
  return (
    <div className="px-4 py-3" data-testid={`machine-installed-${m.id}`}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 text-sm text-ink-muted">{note}</span>
        <span className="flex shrink-0 items-center gap-1">
          {previous && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('rollback')} data-testid={`machine-rollback-${m.id}`}>
              Roll back to {previous.version}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking('uninstall')} data-testid={`machine-uninstall-${m.id}`}>
            Uninstall
          </Button>
        </span>
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
            <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
              Keep
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Auto reconnect (#1341, owner decision 2026-10-20), on by default: this computer connects when it starts and again
 * after every drop. Off, it tries once when it starts and then only when you press Connect, which suits a laptop that is
 * often closed or a server used once a week. The box shows what the host answered, as the autostart switch does.
 */
function AutoReconnectSwitch({ m }: { m: MachineInfo }) {
  const setAutoReconnect = useStore((s) => s.setMachineAutoReconnect)
  const [pending, setPending] = useState(false)
  return (
    <SettingsRow
      label={<label htmlFor={`machine-auto-reconnect-input-${m.id}`}>Auto reconnect</label>}
      hint={
        <span data-testid={`machine-auto-reconnect-note-${m.id}`}>
          {m.autoReconnect
            ? 'Connects when Centralu starts and again after every drop.'
            : 'Tries once when Centralu starts. After a drop it stays away until you press Connect, and agents do not connect it for you.'}
        </span>
      }
      control={
        <Switch
          id={`machine-auto-reconnect-input-${m.id}`}
          checked={m.autoReconnect}
          disabled={pending || !!m.operation}
          onChange={(e) => {
            setPending(true)
            void setAutoReconnect(m.id, e.target.checked).finally(() => setPending(false))
          }}
          data-testid={`machine-auto-reconnect-${m.id}`}
        />
      }
    />
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
    <SettingsRow
      label={<label htmlFor={`machine-autostart-input-${m.id}`}>{row.label}</label>}
      hint={row.note ? <span data-testid={`machine-autostart-note-${m.id}`}>{withCode(row.note)}</span> : undefined}
      control={
        <Switch
          id={`machine-autostart-input-${m.id}`}
          checked={row.on}
          disabled={pending || !!m.operation}
          onChange={(e) => {
            const on = e.target.checked
            setPending(true)
            void setAutostart(m.id, on).finally(() => setPending(false))
          }}
          data-testid={`machine-autostart-${m.id}`}
        />
      }
    />
  )
}

/**
 * The reverse direction (#550, docs/plans/remote-hub.md §12.7, owner decision 2026-10-18): this machine's sessions may
 * ask this computer's projects. Per machine, off by default. Turning it on asks once and says what it allows; turning it
 * off does not ask, and forgets the pairs. While it is on, the pairs approved on this computer's card are listed, each
 * withdrawn here. The switch shows what the host answered: it moves when the row does, not when it is clicked.
 */
function AsksSwitch({ m }: { m: MachineInfo }) {
  const setAsks = useStore((s) => s.setMachineAsks)
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const row = asksRow(m)
  if (!row) return null
  const turn = (on: boolean) => {
    setPending(true)
    void setAsks(m.id, on).finally(() => {
      setPending(false)
      setConfirming(false)
    })
  }
  return (
    <SettingsRow
      label={<label htmlFor={`machine-asks-input-${m.id}`}>{row.label}</label>}
      hint={row.note ? <span data-testid={`machine-asks-note-${m.id}`}>{row.note}</span> : undefined}
      control={
        <Switch
          id={`machine-asks-input-${m.id}`}
          checked={row.on}
          disabled={pending || confirming}
          onChange={(e) => (e.target.checked ? setConfirming(true) : turn(false))}
          data-testid={`machine-asks-${m.id}`}
        />
      }
    >
      {confirming && (
        <InlineConfirm
          text={row.confirm}
          yesLabel="Turn on"
          noLabel="Cancel"
          busy={pending}
          onYes={() => turn(true)}
          onNo={() => setConfirming(false)}
          testId={`machine-asks-confirm-${m.id}`}
          yesTestId={`machine-asks-yes-${m.id}`}
          noTestId={`machine-asks-no-${m.id}`}
          textTestId={`machine-asks-text-${m.id}`}
        />
      )}
      {row.on && <AskPairs m={m} />}
    </SettingsRow>
  )
}

/**
 * The machine's own "Allow auto from a linked computer" (#1273 review, owner decision 2026-10-19), read and set over the
 * link, so a machine with no window of its own (`centralu serve`) can be set from here. The machine reads it at each
 * start: off, a child this computer's `auto` session starts there runs under normal, and this computer asks first. The
 * switch shows what the machine answered; while the link is down, or on a machine from before it, it says so instead.
 */
function HubAutoSwitch({ m }: { m: MachineInfo }) {
  const platform = usePlatform()
  // The machine's answer to the last change, kept only while the link is as it was then (#1273 review): a link that
  // goes or comes back reads the machine again, and that read is what shows
  const [set, setSet] = useState<{ state: 'on' | 'off' | 'older' | 'unreachable'; status: MachineInfo['status'] } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // Read again when the link comes and goes
  const read = useLoad(() => platform.machines.hubAuto(m.id), [platform, m.id], [m.status])
  const state = (set && set.status === m.status ? set.state : undefined) ?? read.data ?? (read.error ? 'unreachable' : undefined)
  if (state === undefined) return null
  const turn = (allowed: boolean) => {
    setPending(true)
    setFailed(null)
    void platform.machines
      .hubAuto(m.id, allowed)
      .then(
        (next) => setSet({ state: next, status: m.status }),
        (err: unknown) => setFailed(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setPending(false))
  }
  return (
    <SettingsRow
      label={<label htmlFor={`machine-hub-auto-input-${m.id}`}>Let auto sessions here start agents under auto on {m.name}</label>}
      hint={
        <span data-testid={`machine-hub-auto-note-${m.id}`}>
          {failed
            ? `Not changed: ${failed}`
            : state === 'older'
              ? `${m.name} runs a Centralu from before this setting: an agent started there always runs under normal, and this computer asks first.`
              : state === 'unreachable'
                ? `${m.name} is not connected, so its setting cannot be read or changed now.`
                : `${m.name}'s own "Allow auto from a linked computer", set from here. On, an agent that a session under auto here starts there runs under auto too, without asking; off, it runs under normal and you are asked each time.`}
        </span>
      }
      control={
        <Switch
          id={`machine-hub-auto-input-${m.id}`}
          checked={state === 'on'}
          disabled={pending || state === 'older' || state === 'unreachable'}
          onChange={(e) => turn(e.target.checked)}
          data-testid={`machine-hub-auto-${m.id}`}
        />
      }
    />
  )
}

/** The pairs of one machine approved on this computer's card (#550): a session there, a project here */
function AskPairs({ m }: { m: MachineInfo }) {
  const platform = usePlatform()
  const version = useStore((s) => s.projectConsentsVersion)
  // Read again whenever a pair is approved or withdrawn (`project_consents_changed`)
  const read = useLoad(async () => (await platform.machines.askConsents()).filter((c) => c.machineId === m.id), [platform, m.id], [version])
  const keyOf = (c: MachineAskConsent) => `${c.sessionId}>${c.projectId}`
  return (
    <SettingsCard className="mt-2.5 bg-surface-side/60" testId={`machine-ask-pairs-${m.id}`}>
      <GrantList
        load={read}
        keyOf={keyOf}
        row={(c) => (
          <span className="min-w-0 truncate text-xs text-ink">
            {c.sessionName} <span className="text-ink-faint">may ask</span> {c.projectName}
          </span>
        )}
        dateOf={(c) => c.decidedAt}
        action={{
          label: 'Withdraw',
          failed: 'Could not withdraw it',
          testId: (c) => `machine-ask-withdraw-${m.id}-${keyOf(c)}`,
          run: (c) => platform.machines.withdrawAsk(c.machineId, c.sessionId, c.projectId),
        }}
        what="the approved sessions"
        empty={`No session on ${m.name} is allowed yet: the first ask of each asks you here.`}
        testIds={{
          list: `machine-ask-pairs-list-${m.id}`,
          empty: `machine-ask-pairs-empty-${m.id}`,
          failed: `machine-ask-pairs-failed-${m.id}`,
          error: `machine-ask-pairs-error-${m.id}`,
          row: (c) => `machine-ask-pair-${m.id}-${keyOf(c)}`,
        }}
      />
    </SettingsCard>
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
    <div className="mt-2.5 rounded-md border border-line bg-surface-floor px-3 py-2.5" data-testid={`machine-versions-${m.id}`}>
      <p className="text-xs leading-body text-ink" data-testid={`machine-versions-text-${m.id}`}>
        {p.text}
      </p>
      {p.older === 'hub' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* The same door as Settings → Updates: npm, then a relaunch that keeps agents running */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void (update?.newer ? applyUpdate() : checkUpdate(true))}
            data-testid={`machine-update-hub-${m.id}`}
          >
            {update?.newer && update.latest ? `Update this computer to ${update.latest}` : 'Check for an update'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenCategory('updates')}>
            Open Updates
          </Button>
        </div>
      )}
      {p.updateHere && !confirming && (
        <div className="mt-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!!m.operation}
            onClick={() => setConfirming(true)}
            data-testid={`machine-update-remote-${m.id}`}
          >
            Update {m.name} to {p.target}
          </Button>
        </div>
      )}
      {p.updateHere && confirming && (
        <StopConfirm
          m={m}
          action="Update"
          onCancel={() => setConfirming(false)}
          onConfirm={(when) => {
            setConfirming(false)
            void change(m.id, 'update', when)
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
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() =>
                void navigator.clipboard?.writeText(p.remoteCommand!).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
      {!p.held ? null : p.compatible ? (
        <Button
          variant="quiet"
          size="sm"
          className="mt-2"
          onClick={() => void accept(m.id)}
          data-testid={`machine-accept-versions-${m.id}`}
          title="Connect without aligning. Asked again when either side changes version."
        >
          Connect anyway
        </Button>
      ) : (
        <p className="mt-2 text-xs leading-body text-ink-muted" data-testid={`machine-versions-refused-${m.id}`}>
          Machines on different protocol versions cannot connect, even anyway.
        </p>
      )}
    </div>
  )
}
