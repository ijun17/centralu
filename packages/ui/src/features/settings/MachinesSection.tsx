import { useState } from 'react'
import type { MachineInfo, RemoteShell } from '@cc/protocol'
import { machineProblem, versionPrompt } from '@cc/core'
import { useStore } from '../../store/store.js'
import { MachineStatusMark } from '../machines/MachineTag.jsx'

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

const SHELL_LABEL: Record<RemoteShell, string> = {
  posix: 'Linux or macOS',
  powershell: 'Windows',
  wsl: 'WSL on Windows',
}

function MachineRow({ m, onOpenCategory }: { m: MachineInfo; onOpenCategory: (category: 'updates') => void }) {
  const reconnect = useStore((s) => s.reconnectMachine)
  const remove = useStore((s) => s.removeMachine)
  const setToast = useStore((s) => s.setToast)
  const [confirming, setConfirming] = useState(false)
  const problem = machineProblem(m)
  const where = [m.sshTarget, SHELL_LABEL[m.shell], m.shell === 'wsl' ? m.wslDistro : null, m.command ? `runs ${m.command}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="rounded-md border border-line px-2.5 py-2" data-testid={`machine-row-${m.id}`} data-status={m.status}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm text-ink">{m.name}</span>
        <MachineStatusMark status={m.status} testId={`machine-row-status-${m.id}`} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {m.status !== 'connected' && (
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

/**
 * The version prompt (plan §4): bring the older side up to the newer one, and connect anyway when both speak one
 * protocol. Phase 1 cannot update another machine, so for an older remote the exact command to run there is given.
 */
function VersionPrompt({ m, onOpenCategory }: { m: MachineInfo; onOpenCategory: (category: 'updates') => void }) {
  const accept = useStore((s) => s.acceptMachineVersions)
  const update = useStore((s) => s.update)
  const applyUpdate = useStore((s) => s.applyUpdate)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const [copied, setCopied] = useState(false)
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
      {p.remoteCommand && (
        <div className="mt-2">
          <p className="text-xs leading-body text-ink-muted">
            This version cannot update {m.name} for you yet. On {m.name}, run this, then restart{' '}
            <code className="font-mono">centralu serve</code>:
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
      {p.compatible ? (
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

/** A fix with its commands set in the code face: the text between backticks */
function withCode(text: string) {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono text-ink">
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  )
}

const fieldClass =
  'w-full rounded-md border border-line bg-surface-floor px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none'

function AddMachineForm({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const add = useStore((s) => s.addMachine)
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [shell, setShell] = useState<RemoteShell>('posix')
  const [distro, setDistro] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() && target.trim() && (shell !== 'wsl' || distro.trim())
  return (
    <form
      className="mt-3 rounded-md border border-line px-2.5 py-2.5"
      data-testid="machines-add-form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!ready) return
        setBusy(true)
        setError(null)
        try {
          await add({
            name: name.trim(),
            sshTarget: target.trim(),
            shell,
            wslDistro: shell === 'wsl' ? distro.trim() : null,
            command: command.trim() || null,
          })
          onDone()
        } catch (err) {
          // Kept in the form with what was typed: the host says which field it refused and why
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
      // Typing here must not reach the app's shortcuts
      onKeyDown={(e) => e.stopPropagation()}
    >
      <p className="text-sm text-ink">Add a machine</p>
      <label className="mt-2 block text-xs text-ink-muted">
        Name
        <input
          className={`mt-1 ${fieldClass}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ubuntu server"
          spellCheck={false}
          data-testid="machines-add-name"
        />
      </label>
      <label className="mt-2 block text-xs text-ink-muted">
        ssh target
        <input
          className={`mt-1 ${fieldClass}`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="me@server, or a Host from ~/.ssh/config"
          spellCheck={false}
          autoComplete="off"
          data-testid="machines-add-target"
        />
      </label>
      <p className="mt-2 text-xs text-ink-muted">It runs</p>
      <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Remote shell">
        {(Object.keys(SHELL_LABEL) as RemoteShell[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={shell === k}
            onClick={() => setShell(k)}
            data-testid={`machines-add-shell-${k}`}
            className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
              shell === k ? 'border-ink-muted bg-surface-hover/40 text-ink' : 'border-line text-ink-muted hover:border-line-strong hover:text-ink'
            }`}
          >
            {SHELL_LABEL[k]}
          </button>
        ))}
      </div>
      {shell === 'wsl' && (
        <label className="mt-2 block text-xs text-ink-muted">
          WSL distro
          <input
            className={`mt-1 ${fieldClass}`}
            value={distro}
            onChange={(e) => setDistro(e.target.value)}
            placeholder="Ubuntu-24.04 (wsl.exe -l -v lists them)"
            spellCheck={false}
            data-testid="machines-add-distro"
          />
        </label>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink">Command (optional)</summary>
        <label className="mt-1 block text-xs text-ink-muted">
          What runs in place of <code className="font-mono">centralu</code> there, when it is not on the PATH ssh gets
          <input
            className={`mt-1 ${fieldClass}`}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="~/.npm-global/bin/centralu"
            spellCheck={false}
            autoComplete="off"
            data-testid="machines-add-command"
          />
        </label>
      </details>
      {error && (
        <p className="mt-2 text-xs leading-body text-danger" data-testid="machines-add-error">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {canCancel && (
          <button type="button" className="rounded-md px-2 py-0.5 text-xs text-ink-faint hover:text-ink" onClick={onDone}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy || !ready}
          className="rounded-md border border-line bg-surface-raised px-2.5 py-0.5 text-xs text-ink transition-colors hover:border-line-strong disabled:opacity-50"
          data-testid="machines-add-confirm"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  )
}
