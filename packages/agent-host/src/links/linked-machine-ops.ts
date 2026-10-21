import { errorMessage, HostActivity, isNewerVersion, releaseOf, turnsRunning } from '@cc/protocol'
import type { MachineAutostartResult, MachineInfo, MachineInstallResult, MachineOperation, MachineUninstallResult } from '@cc/protocol'
import { autostartRemote } from './autostart.js'
import { installRemote, type InstallResult } from './install.js'
import type { LinkInstaller } from './link-deps.js'
import { LinkedMachineConnection } from './linked-machine-connection.js'
import { belowFloor, NodeTooOld, switchedSentence, updateNodeSentence } from './node-floor.js'
import { installVersion, type InstallVersion } from './registry.js'
import { RemoteClient } from './remote-client.js'
import { lastLine, npmInstall, parseRevoke, revokeCommand, type RemoteCommand, type RemoteRun } from './tunnel.js'
import { rollbackRemote, uninstallRemote, updateRemote, type HostControl, type UpdateStep } from './update.js'
import { rpcError } from '../rpc-error.js'

/**
 * A linked machine (links.ts): its connection (linked-machine-connection.ts), and what the person
 * asks of it: install, update, rollback, uninstall, start at boot, and what would stop if it updated
 */

const linkError = (message: string) => rpcError(message)

/** How often an update that waits for the sessions there to finish reads what is running (#1399) */
const ACTIVITY_POLL_MS = 15_000
/** How long after a reading that says none is in a turn it is read once more, right before the host is stopped (#1399) */
const ACTIVITY_SETTLE_MS = 3_000
/** How many times a reading that failed is repeated before the update stops waiting for what it cannot see (#1399) */
const ACTIVITY_UNREAD_RETRIES = 2

/** Why a signal was aborted, as an Error */
const reasonOf = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))

/** Waits `ms`, or until `signal` aborts (and then throws its reason) */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(reasonOf(signal))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    t.unref?.()
    function onAbort() {
      clearTimeout(t)
      reject(reasonOf(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class LinkedMachine extends LinkedMachineConnection {
  /** One install, update, rollback, uninstall or start-at-boot change at a time per machine (`begin`; the remote also holds `install.lock`) */
  private busy: MachineOperation['kind'] | null = null
  /** The person removed what the hub installed (`machines.uninstall`); it does not come back unasked, until they install again */
  private removedByPerson = false

  /** An operation the person started keeps retrying on the backoff while it runs, whatever the switch says (#1341) */
  protected override inOperation(): boolean {
    return this.held || this.busy !== null
  }

  /**
   * Installs the hub's version there (`machines.install`, install.ts, plan §10.2). A host running
   * there keeps running; a link that is not connected (nothing was installed, or nothing runs) opens
   * again at once, and finds the managed launcher first
   */
  async install(): Promise<MachineInstallResult> {
    const pick = await this.versionToInstall()
    return this.operate('install', pick.version, async (c, installer) => {
      if (pick.note) this.deps.log?.(`[links] ${this.name}: ${pick.note}`)
      const r = await installRemote({
        exec: c.exec,
        spec: c.spec,
        target: c.target,
        version: pick.version,
        runtime: installer.runtime(),
        script: c.script,
        registry: installer.registry,
        nodeDist: installer.nodeDist,
        onStep: c.step,
      })
      this.removedByPerson = false
      this.deps.log?.(`[links] ${this.name}: installed Centralu ${r.current.version} on Node ${r.current.node}${r.previous ? `; ${r.previous.version} kept to roll back to` : ''}`)
      return { ...this.installedNow(r), ...(pick.note ? { note: pick.note } : {}) }
    })
  }

  /**
   * `machines.update` (update.ts, plan §10.5): install beside, wait until no turn runs there (`when: 'idle'`, the default, #1399),
   * stop, switch, start, check, or put back. `when: 'now'`: no wait, the turns running are stopped and the answer says so
   */
  async update(opts: { when?: 'idle' | 'now' } = {}): Promise<MachineInstallResult> {
    const pick = await this.versionToInstall()
    // Never down: a local build whose base is unpublished may be handed an older release than the remote runs. A dev
    // build put there from a commit (`<base>.local.N`, `pnpm remote-dev`, #1036) going back to its own release is no downgrade
    const there = this.versions?.remote.version
    if (there && releaseOf(there) !== pick.version && isNewerVersion(there, pick.version)) {
      throw linkError(`${this.name} runs Centralu ${there}, newer than ${pick.version}, the version this computer would install; updating would downgrade it, so nothing was changed`)
    }
    return this.operate('update', pick.version, async (c, installer) => {
      if (pick.note) this.deps.log?.(`[links] ${this.name}: ${pick.note}`)
      c.beforeStop = () => this.beforeStop(c, opts.when ?? 'idle')
      const r = await updateRemote(c, {
        version: pick.version,
        runtime: installer.runtime(),
        registry: installer.registry,
        nodeDist: installer.nodeDist,
      })
      this.deps.log?.(`[links] ${this.name}: updated to Centralu ${r.current.version}${r.previous ? `; ${r.previous.version} kept to roll back to` : ''}`)
      const note = [pick.note, r.note].filter(Boolean).join(' ')
      return { ...this.installedNow(r), ...(note ? { note } : {}) }
    })
  }

  /** The update waits for the sessions there to finish; `cancelUpdate`, a removed machine and the hub stopping end the wait */
  private idleWait: AbortController | null = null

  /** `machines.cancelUpdate` (#1399): ends the wait for the sessions there; the update fails and nothing was switched. False when none waits */
  cancelUpdate(): boolean {
    const wait = this.idleWait
    if (!wait) return false
    wait.abort(new Error(`The update of ${this.name} was cancelled while it waited for the sessions there to finish; nothing was switched`))
    return true
  }

  /** Removed, or the hub stopping: nothing waits for sessions of a machine that is gone */
  override async stop(): Promise<void> {
    this.idleWait?.abort(new Error(`The update of ${this.name} ended while it waited for the sessions there to finish, since the machine was removed or the hub stopped; nothing was switched`))
    await super.stop()
  }

  /**
   * Before the running host is stopped (#1399). `idle`: waits until no session there is in a turn, reading what is running every
   * `ACTIVITY_POLL_MS` (the row says `wait_idle` meanwhile). Once a reading says none, it is read again a few seconds later, right
   * before the host is held and stopped: the stop takes seconds, and a turn that began in them would end with it. A machine that
   * cannot be asked at all (a host from before `host.activity`, a link held on another protocol) is not waited for, and one whose
   * every answer failed is read again twice, then not waited for either: waiting on what was never seen would never end. Once an
   * answer has come, though, the wait goes on through failed readings (the row says `wait_unread`) and the host is stopped only on
   * a successful reading of none in a turn, since a busy or dropped remote reads as failed too; Cancel or Update now are the ways
   * out. `now`: stops at once, and the answer says how many turns that ended
   */
  private async beforeStop(c: HostControl, when: 'idle' | 'now'): Promise<string | null> {
    if (when === 'now') {
      const running = turnsRunning(await this.activity())
      if (running === 0) return null
      const note = `Updating stopped Centralu on ${this.name} with ${running} ${running === 1 ? 'session' : 'sessions'} in a turn; they resume on the new version, and a turn in progress was lost`
      this.deps.log?.(`[links] ${this.name}: ${note}`)
      return note
    }
    const wait = new AbortController()
    this.idleWait = wait
    const poll = this.deps.activityPollMs ?? ACTIVITY_POLL_MS
    const settle = Math.min(poll, ACTIVITY_SETTLE_MS)
    /** Reads what runs; throws the reason when the wait was ended while the reading was out */
    const read = async () => {
      wait.signal.throwIfAborted()
      const r = await this.readActivity()
      wait.signal.throwIfAborted()
      return r
    }
    try {
      /** Which step the row shows now: null before the first, then `wait_idle` or `wait_unread` */
      let shown: 'wait_idle' | 'wait_unread' | null = null
      /** A reading has succeeded: from then on what runs there is known to be readable, so a failed one proves nothing */
      let seen = false
      let blind = 0
      const show = (step: 'wait_idle' | 'wait_unread', why: string) => {
        if (shown === step) return
        shown = step
        c.step(step)
        this.deps.log?.(`[links] ${this.name}: ${why}`)
      }
      const unread = () => show('wait_unread', 'what runs there cannot be read now; the update keeps waiting, since the sessions there may be in a turn (Cancel ends it)')
      const busy = (n: number) => show('wait_idle', `the update waits for ${n} ${n === 1 ? 'session' : 'sessions'} in a turn`)
      for (;;) {
        const r = await read()
        if (r.activity) {
          seen = true
          blind = 0
          const running = turnsRunning(r.activity)
          if (running === 0) {
            await pause(settle, wait.signal)
            const again = await read()
            // Only a reading that succeeded and shows nobody in a turn lets the host be stopped: a failed one proves nothing
            if (again.activity && turnsRunning(again.activity) === 0) {
              if (shown) c.step('stop')
              return null
            }
            if (again.activity) busy(turnsRunning(again.activity))
            else unread()
          } else busy(running)
        } else if (seen) {
          unread()
        } else if (r.cannot || ++blind > ACTIVITY_UNREAD_RETRIES) {
          // Never read: there is nothing to wait for that could be seen, and waiting on it would never end
          this.deps.log?.(`[links] ${this.name}: it cannot be told what runs there, so the update does not wait for it`)
          return null
        }
        await pause(poll, wait.signal)
      }
    } finally {
      if (this.idleWait === wait) this.idleWait = null
    }
  }

  /**
   * The version `install` and `update` put on the remote: this hub's own, or for a local build the
   * release it was cut from (registry.ts `installVersion`, #689). Where this hub installs nothing
   * (no installer, a development build) its own version is returned and `operate` refuses
   */
  private async versionToInstall(): Promise<InstallVersion> {
    const hub = this.deps.hub
    if (!this.deps.installer || hub.dev) return { version: hub.version, note: null }
    try {
      return await installVersion(hub.version, hub.protocolVersion, this.deps.installer.registry)
    } catch (err) {
      throw linkError((err as Error).message)
    }
  }

  /** `machines.rollback`: back to `previous`, one step */
  rollback(): Promise<MachineInstallResult> {
    const current = this.installed?.current
    const previous = this.installed?.previous
    if (!current || !previous) return Promise.reject(linkError(`There is no earlier version installed on ${this.name} to go back to`))
    return this.operate('rollback', previous.version, async (c) => {
      const r = await rollbackRemote(c, { current, previous })
      this.deps.log?.(`[links] ${this.name}: rolled back to Centralu ${r.current.version}`)
      return this.installedNow(r)
    })
  }

  /** `machines.uninstall`: stops the host there and removes what the hub installed; the data stays */
  uninstall(): Promise<MachineUninstallResult> {
    if (!this.installed?.current) return Promise.reject(linkError(`Nothing this computer installed is on ${this.name}`))
    return this.operate('uninstall', null, async (c) => {
      const r = await uninstallRemote(c)
      this.installed = { managed: false, current: null, previous: null }
      this.removedByPerson = true
      if (this.bootStart) this.bootStart = { ...this.bootStart, on: false, linger: null }
      this.deps.log?.(`[links] ${this.name}: removed the Centralu this computer installed; its data stays`)
      return { machine: this.info(), stopped: r.stopped }
    })
  }

  /**
   * `machines.revokeCredential` (#1405): withdraws one of the machine's other full credentials, by running
   * `centralu serve --revoke <id>` there over the link's ssh. Its next hello there is refused; a connection already open
   * with it stays until it closes. Not this hub's own credential, which the next link would only make again
   */
  async revokeCredential(credentialId: string): Promise<MachineInfo> {
    const exec = this.tunnel.exec?.bind(this.tunnel)
    if (!exec) throw linkError(`This computer has no shell on ${this.name} to withdraw a credential`)
    if (this.endpoint?.line.credential === credentialId) throw linkError(`That is this computer's own credential on ${this.name}, made again at each link`)
    const r = await exec(revokeCommand(this.record.remote, credentialId))
    if (r.code === 255) throw linkError(`ssh could not reach ${this.record.sshTarget}: ${lastLine(r.stderr) || 'no answer'}`)
    const said = parseRevoke(r.stdout)
    if (said === null) throw linkError(`${this.name} did not say whether it withdrew the credential${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`)
    // Gone there (now, or before): gone from the row too, also from a line a reconnect read before the revoke landed
    this.revokedHere.add(credentialId)
    this.deps.log?.(`[links] ${this.name}: ${said ? 'withdrew' : 'found no'} full credential ${credentialId}`)
    // And the list read again, through the link when it is up: what else changed there shows with it
    await this.readCredentials?.()
    this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    return this.info()
  }

  /**
   * `machines.autostart` (plan §10.4, owner decision 4): the machine's host started at boot, or not, or
   * (without `on`) whether it is. The Centralu there writes its own entry; nothing starts or stops now.
   * Not while an install, update, rollback or uninstall runs there: the entry names a launcher that one
   * may be removing
   */
  async autostart(on?: boolean): Promise<MachineAutostartResult> {
    const exec = this.tunnel.exec?.bind(this.tunnel)
    if (!exec) throw linkError(`This computer has no shell on ${this.name} to change how it starts`)
    const action = on === undefined ? 'status' : on ? 'on' : 'off'
    const done = this.begin('autostart', action, null)
    let state: MachineAutostartResult['autostart']
    try {
      const a = await autostartRemote({ exec, spec: this.record.remote, target: this.record.sshTarget }, action)
      state = { on: a.on, how: a.how, linger: a.linger }
      this.bootStart = state
      if (on !== undefined) {
        this.deps.log?.(`[links] ${this.name}: ${a.on ? `starts Centralu at boot (${a.how}${a.how === 'systemd' && a.linger === false ? ', at login until lingering is enabled' : ''})` : 'no longer starts Centralu at boot'}`)
      }
    } catch (err) {
      this.deps.log?.(`[links] ${this.name}: autostart ${action} failed: ${(err as Error).message}`)
      throw linkError((err as Error).message)
    } finally {
      done()
    }
    // The row as it is after the change, no longer saying it runs
    return { machine: this.info(), autostart: state }
  }

  /**
   * The machine's own "Allow auto from a linked computer" (#1273 review): read (`host.hubAuto` there), or set when
   * `allowed` is given (`host.setHubAuto`), as that machine answers it. Only over the link while it is up: nothing is
   * started or connected for it. `older`: that machine's Centralu predates the switch; `unreachable`: the link is not up,
   * or went down during the call. Any other failure (a timeout, a refusal there) is thrown in its own words (#1273
   * review), never passed off as the link being down
   */
  async hubAuto(allowed?: boolean): Promise<'on' | 'off' | 'older' | 'unreachable'> {
    const client = this.client
    if (!client?.connected) return 'unreachable'
    try {
      const r = (await (allowed === undefined ? client.call('host.hubAuto', {}) : client.call('host.setHubAuto', { allowed }))) as { allowed?: unknown }
      return r?.allowed === true ? 'on' : 'off'
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      if (/^Unknown method/.test(message)) return 'older'
      if (!client.connected) return 'unreachable'
      throw rpcError(`${this.name} did not answer for its "Allow auto from a linked computer": ${message}`)
    }
  }

  /**
   * What would stop there if its host stopped now (`host.activity` on the remote), for the "Update"
   * prompt. Through the link when connected; while the link is held at `versions_differ` on one
   * protocol, through a short connection of its own. Null when the machine cannot say
   */
  activity(): Promise<HostActivity | null> {
    return this.readActivity().then((r) => r.activity)
  }

  /**
   * `activity`, and whether a null is final (#1399): `cannot` when the machine cannot be asked at all (no way to reach its host, the
   * link held on another protocol, a host from before `host.activity`), as against an answer that failed, which may be asked again
   */
  private readActivity(): Promise<{ activity: HostActivity | null; cannot: boolean }> {
    const read = (r: unknown): { activity: HostActivity | null; cannot: boolean } => {
      const p = HostActivity.safeParse(r)
      return { activity: p.success ? p.data : null, cannot: false }
    }
    const failed = (err: unknown) => ({ activity: null, cannot: /^Unknown method/.test(errorMessage(err)) })
    if (this.client?.connected) return this.client.call('host.activity', {}).then(read, failed)
    const e = this.endpoint
    if (!e?.url || this.versions?.compatible === false || this.held) return Promise.resolve({ activity: null, cannot: true })
    return new Promise((resolve) => {
      let settled = false
      const done = (v: { activity: HostActivity | null; cannot: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.close()
        resolve(v)
      }
      const client = new RemoteClient(
        { ...this.deps.client, url: e.url, token: e.token, proveHost: e.line.proof === true, handshakeTimeoutMs: 5_000, callTimeoutMs: 5_000 },
        { hello: () => void client.call('host.activity', {}).then(read, failed).then(done), refused: () => done({ activity: null, cannot: false }) },
      )
      const timer = setTimeout(() => done({ activity: null, cannot: false }), 8_000)
      client.connect()
    })
  }

  private installedNow(r: InstallResult): MachineInstallResult {
    this.installed = { managed: true, current: r.current, previous: r.previous }
    return { machine: this.info(), current: r.current, previous: r.previous, removed: r.removed, left: r.left, ...(r.note ? { note: r.note } : {}) }
  }

  /**
   * The one change at a time per machine that `operate` and `autostart` share: refused while another runs, naming
   * it, and said on the row while it runs (`MachineInfo.operation`), so the window greys out what would be refused. The
   * returned `done` clears both and sends the row again; `then` runs after the clear and before that send.
   * `step` null leaves the row unchanged until the operation's first step (an install says `preflight` at once)
   */
  private begin(kind: MachineOperation['kind'], step: string | null, target: string | null): (then?: () => void) => void {
    if (this.busy) throw linkError(`${this.name} is busy with ${this.busy}; wait until it is done`)
    this.busy = kind
    if (step !== null) {
      this.operation = { kind, step, target, at: Date.now() }
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
    return (then) => {
      this.busy = null
      this.operation = null
      then?.()
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
  }

  /**
   * Runs one install, update, rollback or uninstall: refused where this hub cannot install (no
   * installer or shell, a development build, a command of the person's own), one at a time, with its
   * steps in the row. Afterwards the link opens again, also after a failure
   */
  /**
   * Why an install, update or another operation on the machine would be refused before it starts, or null: this
   * computer installs nothing, a development hub has nothing published to install, or the machine runs a command of
   * its own. `operate` refuses with it; the orchestrator's install_machine says it before its card (#1219)
   */
  operationRefusal(kind: MachineOperation['kind']): string | null {
    if (!this.deps.installer || !this.tunnel.exec) return `This computer cannot install on ${this.name}`
    if (this.deps.hub.dev && (kind === 'install' || kind === 'update')) {
      return `A development build is not published, so it cannot be installed on ${this.name}; install the latest release there (${npmInstall(this.record.remote)})`
    }
    if (this.record.remote.command) return `${this.name} runs a command of its own in place of centralu; clear it to use an installed one`
    return null
  }

  private async operate<T>(kind: MachineOperation['kind'], target: string | null, fn: (c: HostControl, installer: LinkInstaller) => Promise<T>): Promise<T> {
    const refused = this.operationRefusal(kind)
    if (refused) throw linkError(refused)
    const installer = this.deps.installer!
    const tunnelExec = this.tunnel.exec!.bind(this.tunnel)
    const done = this.begin(kind, null, target)
    const at = Date.now()
    const step = (s: UpdateStep) => {
      this.deps.log?.(`[links] ${this.name}: ${kind}${target ? ` ${target}` : ''}: ${s}`)
      this.operation = { kind, step: s, target, at }
      this.deps.broadcast({ type: 'machine_status', machine: this.info() })
    }
    let result: T
    try {
      result = await fn(this.control(tunnelExec, installer.script(), step), installer)
    } catch (err) {
      this.deps.log?.(`[links] ${this.name}: ${kind} failed: ${(err as Error).message}`)
      throw linkError((err as Error).message)
    } finally {
      const wasHeld = this.held
      this.held = false
      done(() => {
        if (!this.stopped && (wasHeld || this.status !== 'connected')) this.reconnect()
      })
    }
    // The row as it is now, not as it was mid-operation: it said `updating` after an uninstall (#482)
    return result && typeof result === 'object' && 'machine' in result ? { ...result, machine: this.info() } : result
  }

  /** What update.ts runs things there with */
  private control(exec: (command: RemoteCommand) => Promise<RemoteRun>, script: string, step: (s: UpdateStep) => void): HostControl {
    const hold = async () => {
      this.held = true
      this.clearRetry()
      // An opening already under way finishes first: it may be about to start a host of its own
      await this.opening?.catch(() => undefined)
      this.clearRetry()
      this.client?.close()
      this.client = null
      this.setStatus('updating', null)
    }
    return {
      exec,
      spec: this.record.remote,
      target: this.record.sshTarget,
      script,
      hold,
      step,
      start: async () => {
        if (!this.tunnel.startHost) throw new Error(`This computer cannot start Centralu on ${this.name}`)
        const started = await this.tunnel.startHost()
        this.hostStarted = { ...started, at: Date.now() }
      },
      answers: (version, ms) =>
        new Promise<boolean>((resolve) => {
          const waiter = (v: string | null) => {
            if (v !== version) return
            clearTimeout(timer)
            this.helloWaiters.delete(waiter)
            resolve(true)
          }
          // No hello from that version in time: the link is held again before the version is put back
          const timer = setTimeout(() => {
            this.helloWaiters.delete(waiter)
            void hold().then(() => resolve(false))
          }, this.deps.checkMs ?? ms)
          this.helloWaiters.add(waiter)
          this.held = false
          this.reconnect()
        }),
    }
  }

  /**
   * The Node there is below the floor, or the host crashed the way that makes it crash (#699): the
   * hub installs its own (the pinned Node of `machines.install`, SHA-256 checked) and says so in one
   * sentence. True when it did, so the caller opens again and finds the managed launcher first. False
   * after reporting why not and scheduling a retry: no installer, a development build (not published),
   * a command of the person's own, an install that failed, or a machine that already runs on the Node
   * the hub installed or was switched once since the link last connected
   */
  protected async switchNode(problem: NodeTooOld, floor: string | null, nodeThere: string | null = null): Promise<boolean> {
    const found = problem.found ?? nodeThere
    const why = { name: this.name, found, floor: floor ?? '', kind: problem.kind }
    const report = (reason: string | null) => {
      this.setStatus('not_running', reason === null ? `Centralu could not be started on ${this.name}: ${problem.message}` : updateNodeSentence({ ...why, reason }))
      this.retryLater()
      return false
    }
    const installer = this.deps.installer
    if (this.switchTried && this.switchFailure) return report(this.switchFailure)
    // A crash says nothing about the Node when the Node is at or above the floor: report it as it is
    if (!floor || this.switchTried || this.installed?.managed || (problem.kind === 'crashed' && found !== null && !belowFloor(found, floor))) return report(null)
    if (!installer || !this.tunnel.exec) return report('this computer installs nothing')
    if (this.deps.hub.dev) return report('this development build is not published')
    if (this.record.remote.command) return report('it runs a command of its own in place of centralu')
    if (this.removedByPerson) return report('it was removed from there on request, and is not put back unasked')
    // An install the person started waits for itself; this one does not count as tried
    if (this.busy) return report(`${this.busy} is running there, and this computer waits for it`)
    this.switchTried = true
    this.deps.log?.(`[links] ${this.name}: ${problem.message}; installing the pinned Node there`)
    let result: MachineInstallResult
    try {
      result = await this.install()
    } catch (err) {
      this.switchFailure = `installing it failed: ${(err as Error).message}`
      return report(this.switchFailure)
    }
    this.switched = { note: switchedSentence({ ...why, node: result.current.node }) }
    this.deps.log?.(`[links] ${this.name}: ${this.switched.note}`)
    return !this.stopped
  }
}
