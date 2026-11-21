import type { RelaunchCheck, RelaunchPort } from '../ports/index.js'
import type { UpdatesMock } from './updates.js'
import { deliver } from '../deliver.js'

/** What the desktop app's keeper offers: background mode (#280), leftover processes, and "Apply now" (#352) */
export class KeeperMock {
  /** A test plants it: the host finds these with ps and lsof, and its unit tests cover the detection */
  strayProcesses: { pid: number; command: string; cwd: string }[] = []

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

  /** Nothing is relaunched: the count says how often the screen asked */
  relaunchCheck: RelaunchCheck = { ready: false, reason: 'The mock does not relaunch until a test says so' }
  relaunches = 0
  relaunchFails: string | null = null
  private hostBusy: boolean | null = false
  private busyWatchers = new Set<(busy: boolean | null) => void>()

  readonly relaunch: RelaunchPort = {
    // The shell reads the version from the bundle on disk an install just replaced (#665)
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

  setHostBusy(busy: boolean | null): void {
    this.hostBusy = busy
    deliver(this.busyWatchers, busy)
  }

  constructor(
    private readonly updatesMock: UpdatesMock,
  ) {}
}
