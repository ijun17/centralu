import { useEffect, useRef, useState } from 'react'
import type { MachineProbe, RemoteShell, SshHost, SshHostList } from '@cc/protocol'
import { firstChoice, probeChoices, probeProblem, sshHostDetail, type MachineChoice } from '@cc/core'
import { useStore } from '../../store/store.js'

export const SHELL_LABEL: Record<RemoteShell, string> = {
  posix: 'Linux or macOS',
  powershell: 'Windows',
  wsl: 'WSL on Windows',
}

/** A fix with its commands set in the code face: the text between backticks */
export function withCode(text: string) {
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

const radioClass = (on: boolean) =>
  `rounded-md border text-xs transition-colors ${on ? 'border-ink-muted bg-surface-hover/40 text-ink' : 'border-line text-ink-muted hover:border-line-strong hover:text-ink'}`

/** What the probe of the picked host stands at */
type Probing = { alias: string; answer: MachineProbe | null | 'asking' }

/**
 * Settings → Machines → Add a machine (#82, #514). The hosts of the ssh config of the computer the host
 * runs on come first, as VS Code's Remote-SSH lists them: picking one asks it once over BatchMode ssh
 * what runs there, and the dialog offers the ready rows ("Windows", "WSL (Ubuntu)", "Linux or macOS")
 * with a name, so linking needs no typing. A row already linked through that alias says so and is not
 * offered again. Typing a target stays: for a host not in the config, and whenever the probe cannot
 * tell. The list is read again each time the dialog opens, since the config can change between uses.
 */
export function AddMachineForm({ onDone, canCancel }: { onDone: () => void; canCancel: boolean }) {
  const add = useStore((s) => s.addMachine)
  const readHosts = useStore((s) => s.machineSshHosts)
  const probeMachine = useStore((s) => s.probeMachine)
  /** The config's hosts: undefined while they are read, null when the host could not say */
  const [hosts, setHosts] = useState<SshHostList | null | undefined>(undefined)
  const [manual, setManual] = useState(false)
  const [probing, setProbing] = useState<Probing | null>(null)
  const [choiceKey, setChoiceKey] = useState<string | null>(null)
  const [name, setName] = useState('')
  /** The person typed a name: picking another row does not overwrite it */
  const nameTyped = useRef(false)
  const [target, setTarget] = useState('')
  const [shell, setShell] = useState<RemoteShell>('posix')
  const [distro, setDistro] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** The alias whose probe is the one on screen; null once the dialog is gone */
  const asking = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    void readHosts().then((list) => {
      if (live) setHosts(list)
    })
    return () => {
      live = false
      asking.current = null
    }
  }, [readHosts])

  const listed = hosts && hosts.hosts.length > 0
  const byHand = manual || hosts === null || (hosts !== undefined && !listed)
  const pickedHost = probing ? hosts?.hosts.find((h) => h.alias === probing.alias) : undefined
  const answer = probing && probing.answer !== 'asking' ? probing.answer : null
  const choices: MachineChoice[] = answer && pickedHost ? probeChoices(pickedHost.alias, answer, pickedHost.linked) : []
  const choice = choices.find((c) => c.key === choiceKey) ?? null

  const choose = (c: MachineChoice | null) => {
    setChoiceKey(c?.key ?? null)
    if (c && !nameTyped.current) setName(c.name)
  }

  const pick = async (h: SshHost) => {
    // Picked again while it is asked: one probe is enough. Picked again after it answered: asked again (a key loaded since)
    if (probing?.alias === h.alias && probing.answer === 'asking') return
    asking.current = h.alias
    setError(null)
    setChoiceKey(null)
    if (!nameTyped.current) setName('')
    setProbing({ alias: h.alias, answer: 'asking' })
    const probe = await probeMachine(h.alias)
    // Another host picked meanwhile, or the dialog closed: this answer is not the one on screen
    if (asking.current !== h.alias) return
    setProbing({ alias: h.alias, answer: probe })
    const first = probe ? firstChoice(probeChoices(h.alias, probe, h.linked)) : null
    setChoiceKey(first?.key ?? null)
    if (first && !nameTyped.current) setName(first.name)
  }

  /** To the typed fields, with what the picked host already told */
  const typeByHand = () => {
    setManual(true)
    if (probing && !target) setTarget(probing.alias)
    if (probing && !name) setName(probing.alias)
    if (choice) {
      setShell(choice.shell)
      setDistro(choice.wslDistro ?? '')
    }
  }

  const ready = byHand
    ? !!(name.trim() && target.trim() && (shell !== 'wsl' || distro.trim()))
    : !!(name.trim() && probing && choice && !choice.linkedAs)

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
          await add(
            byHand
              ? { name: name.trim(), sshTarget: target.trim(), shell, wslDistro: shell === 'wsl' ? distro.trim() : null, command: command.trim() || null }
              : { name: name.trim(), sshTarget: probing!.alias, shell: choice!.shell, wslDistro: choice!.wslDistro, command: command.trim() || null },
          )
          onDone()
        } catch (err) {
          // Kept in the form with what was chosen: the host says which field it refused and why
          setError((err as Error).message)
        } finally {
          setBusy(false)
        }
      }}
      // Typing here must not reach the app's shortcuts
      onKeyDown={(e) => e.stopPropagation()}
    >
      <p className="text-sm text-ink">Add a machine</p>
      {hosts === undefined && (
        <p className="mt-2 text-xs text-ink-faint" data-testid="machines-add-hosts-reading">
          Reading your ssh config…
        </p>
      )}
      {listed && !manual && (
        <HostList
          list={hosts}
          picked={probing?.alias ?? null}
          onPick={(h) => void pick(h)}
        />
      )}
      {listed && !manual && probing && (
        <div className="mt-2" data-testid="machines-add-probe">
          {probing.answer === 'asking' && (
            <p className="text-xs text-ink-faint" data-testid="machines-add-probing">
              Asking {probing.alias} what it runs…
            </p>
          )}
          {probing.answer === null && (
            <p className="text-xs leading-body text-ink" data-testid="machines-add-probe-problem">
              This computer could not ask {probing.alias}. Enter it by hand.
            </p>
          )}
          {answer && <ProbeProblem probe={answer} />}
          {choices.length > 0 && (
            <>
              <p className="text-xs text-ink-muted">It runs</p>
              <div className="mt-1 flex flex-col gap-1" role="radiogroup" aria-label={`What ${probing.alias} runs`} data-testid="machines-add-choices">
                {choices.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    role="radio"
                    aria-checked={choiceKey === c.key}
                    disabled={!!c.linkedAs}
                    onClick={() => choose(c)}
                    data-testid={`machines-add-choice-${c.key}`}
                    className={`flex items-baseline gap-2 px-2 py-1 text-left disabled:cursor-default disabled:opacity-60 ${radioClass(choiceKey === c.key)}`}
                  >
                    <span className="shrink-0">{c.label}</span>
                    <span className="min-w-0 truncate text-ink-faint">{c.linkedAs ? `Linked as ${c.linkedAs}` : c.detail}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {choices.length > 0 && !firstChoice(choices) && (
            <p className="mt-1 text-xs text-ink-faint" data-testid="machines-add-all-linked">
              Every way to reach {probing.alias} is linked already.
            </p>
          )}
          {choices.length > 0 && (
            <label className="mt-2 block text-xs text-ink-muted">
              Name
              <input
                className={`mt-1 ${fieldClass}`}
                value={name}
                onChange={(e) => {
                  nameTyped.current = true
                  setName(e.target.value)
                }}
                spellCheck={false}
                data-testid="machines-add-name"
              />
            </label>
          )}
        </div>
      )}
      {listed && !manual && (
        <button type="button" className="mt-2 text-xs text-ink-faint hover:text-ink" onClick={typeByHand} data-testid="machines-add-by-hand">
          Enter a target by hand
        </button>
      )}
      {byHand && (
        <ManualFields
          name={name}
          setName={(v) => {
            nameTyped.current = true
            setName(v)
          }}
          target={target}
          setTarget={setTarget}
          shell={shell}
          setShell={setShell}
          distro={distro}
          setDistro={setDistro}
          note={hosts && !listed ? `No hosts in ${hosts.configFile}: type the target.` : null}
        />
      )}
      {listed && manual && (
        <button type="button" className="mt-2 text-xs text-ink-faint hover:text-ink" onClick={() => setManual(false)} data-testid="machines-add-from-config">
          Back to the hosts in {hosts.configFile}
        </button>
      )}
      {hosts !== undefined && (
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
      )}
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

/** The config's hosts, one row each: the alias, what ssh resolves it to, and the machines linked through it */
function HostList({ list, picked, onPick }: { list: SshHostList; picked: string | null; onPick: (h: SshHost) => void }) {
  return (
    <div className="mt-2" data-testid="machines-add-hosts">
      <p className="text-xs text-ink-muted">
        From <code className="font-mono">{list.configFile}</code>
      </p>
      <div className="mt-1 flex max-h-56 flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label={`Hosts in ${list.configFile}`}>
        {list.hosts.map((h) => {
          const detail = sshHostDetail(h)
          const linked = h.linked.map((l) => l.name).join(', ')
          return (
            <button
              key={h.alias}
              type="button"
              role="radio"
              aria-checked={picked === h.alias}
              onClick={() => onPick(h)}
              title={h.source}
              data-testid={`machines-add-host-${h.alias}`}
              data-linked={h.linked.length > 0 || undefined}
              className={`flex min-w-0 items-baseline gap-2 px-2 py-1 text-left ${radioClass(picked === h.alias)}`}
            >
              <span className="shrink-0 font-mono">{h.alias}</span>
              {detail && <span className="min-w-0 truncate font-mono text-ink-faint">{detail}</span>}
              {linked && (
                <span className="ml-auto shrink-0 text-ink-faint" data-testid={`machines-add-host-linked-${h.alias}`}>
                  linked as {linked}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {list.notes.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs leading-body text-ink-faint" data-testid="machines-add-notes">
          {list.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** A probe that told nothing, in one sentence and what to do (`probeProblem`) */
function ProbeProblem({ probe }: { probe: MachineProbe }) {
  const problem = probeProblem(probe)
  if (!problem) return null
  return (
    <div className="text-xs leading-body" data-testid="machines-add-probe-problem">
      <p className="text-ink">{problem.title}</p>
      {problem.fix && <p className="mt-0.5 text-ink-muted">{withCode(problem.fix)}</p>}
    </div>
  )
}

type ManualProps = {
  name: string
  setName: (v: string) => void
  target: string
  setTarget: (v: string) => void
  shell: RemoteShell
  setShell: (v: RemoteShell) => void
  distro: string
  setDistro: (v: string) => void
  note: string | null
}

/** The target typed by hand, and what it runs chosen by hand: for a host not in the config, or one the probe could not tell */
function ManualFields({ name, setName, target, setTarget, shell, setShell, distro, setDistro, note }: ManualProps) {
  return (
    <>
      {note && (
        <p className="mt-2 text-xs text-ink-faint" data-testid="machines-add-no-hosts">
          {note}
        </p>
      )}
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
            className={`px-2 py-0.5 ${radioClass(shell === k)}`}
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
    </>
  )
}
