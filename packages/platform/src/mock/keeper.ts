import type { RelaunchCheck, RelaunchPort } from '../ports/index.js'
import type { UpdatesMock } from './updates.js'

/** What the desktop app's keeper offers: background mode (#280), leftover processes, and "Apply now" (#352) */
export class KeeperMock {
  /**
   * The "leftover process" list a test plants — the real thing finds these with ps and lsof,
   * but the mock only fakes that spot (what is being verified is the shutdown flow, not
   * process detection; the detection rules are covered by the host's unit tests).
   */
  strayProcesses: { pid: number; command: string; cwd: string }[] = []

  /** Background mode (#280). The mock stands in for the desktop app, which offers it through the keeper */
  backgroundOn = false

  readonly background = {
    get: async () => this.backgroundOn,
    set: async (on: boolean) => {
      this.backgroundOn = on
      return on
    },
  }

  readonly processes = {
    strays: async () => [...this.strayProcesses],
    stop: async (pids: number[]) => {
      const before = this.strayProcesses.length
      this.strayProcesses = this.strayProcesses.filter((s) => !pids.includes(s.pid))
      return { stopped: before - this.strayProcesses.length }
    },
  }

  /**
   * "Apply now" (#352), as the desktop app with the keeper offers it. Nothing is relaunched here:
   * the count says how often the screen asked, and a test sets what `check` answers and what the
   * keeper's activity report says.
   */
  relaunchCheck: RelaunchCheck = { ready: false, reason: 'The mock does not relaunch until a test says so' }
  relaunches = 0
  /** For tests: the relaunch is refused with this reason */
  relaunchFails: string | null = null
  private hostBusy: boolean | null = false
  private busyWatchers = new Set<(busy: boolean | null) => void>()

  readonly relaunch: RelaunchPort = {
    /*
     * The real shell reads the version out of the bundle on disk (#665 review), which an install just replaced: a test
     * that says only `ready` gets the version it installed. One that names a `version` gets that one, an older bundle
     * included.
     */
    check: async () => {
      const c = { ...this.relaunchCheck }
      const installed = this.updatesMock.updateStatus.phase === 'restart_required' ? this.updatesMock.updateStatus.latest : null
      return c.ready && c.version === undefined && installed ? { ...c, version: installed } : c
    },
    relaunch: async () => {
      if (this.relaunchFails) throw new Error(this.relaunchFails)
      this.relaunches++
    },
    watchBusy: (cb) => {
      this.busyWatchers.add(cb)
      cb(this.hostBusy)
      return () => void this.busyWatchers.delete(cb)
    },
  }

  /** Scenario helper: what the keeper's activity report says (a session working, a terminal…) */
  setHostBusy(busy: boolean | null): void {
    this.hostBusy = busy
    for (const cb of this.busyWatchers) cb(busy)
  }

  constructor(
    private readonly updatesMock: UpdatesMock,
  ) {}
}
