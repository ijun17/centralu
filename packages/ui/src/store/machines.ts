import { errorMessage, type MachineInfo } from '@cc/protocol/client'
import { wakeable } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { omitKey } from './patch.js'
import { machineNameOf } from './names.js'
import { forgetSessions, mergeListedSince, replayPendingEvents, trackWorkingSince, watchLiveEvents } from './sessionList.js'

/**
 * An answer's row is kept only when no `machine_status` came first (#82): `add` answers `connecting` after the version
 * check broadcast `versions_differ` (measured in e2e), and a held link sends nothing more.
 */
function withAnswered(machines: Record<string, MachineInfo>, m: MachineInfo): Record<string, MachineInfo> {
  return machines[m.id] ? machines : { ...machines, [m.id]: m }
}

// Machines whose resync is not whole (docs/state-management.md §7, #1611), per platform: a new one starts clean
const unrecovered = new WeakMap<object, Set<string>>()
const unrecoveredOf = (platform: object): Set<string> => {
  let set = unrecovered.get(platform)
  if (!set) unrecovered.set(platform, (set = new Set()))
  return set
}

export function resyncOwed(platform: object | null, machineId: string): boolean {
  return platform !== null && (unrecovered.get(platform)?.has(machineId) ?? false)
}

/**
 * Bumped by a host resync (#842) or the project's machine's (#1902): an updated host restarts terminals and runs with
 * new ids, so a view keeping the old ones draws a shell under an old tab or stays on a gone run.
 */
export function resyncsOf(s: Pick<AppState, 'hostResyncs' | 'machineResyncs' | 'projects'>, projectId: string): number {
  const machine = s.projects[projectId]?.machine
  return s.hostResyncs + (machine ? (s.machineResyncs[machine] ?? 0) : 0)
}

export function reloadCommandRuns(get: StoreGet, machineId?: string): void {
  const s = get()
  for (const projectId of Object.keys(s.commandRuns)) {
    if (machineId === undefined || s.projects[projectId]?.machine === machineId) void s.loadCommandRuns(projectId)
  }
}

// docs/state-management.md §7 (#1611): a whole list can land after the machine's own resync
export function machinesHoldingMirror(s: Pick<AppState, 'machines' | 'sessions' | 'projects'>): string[] {
  const ids = new Set<string>()
  for (const row of [...Object.values(s.sessions), ...Object.values(s.projects)]) {
    if (row.machine && row.unreachable && s.machines[row.machine]?.status === 'connected') ids.add(row.machine)
  }
  return [...ids]
}

type MachineActions = Pick<
  AppState,
  | 'refreshMachines'
  | 'addMachine'
  | 'machineSshHosts'
  | 'probeMachine'
  | 'removeMachine'
  | 'reconnectMachine'
  | 'disconnectMachine'
  | 'revokeMachineCredential'
  | 'setMachineAutoReconnect'
  | 'changeMachineInstall'
  | 'cancelMachineUpdate'
  | 'setMachineAutostart'
  | 'setMachineAsks'
  | 'machineActivity'
  | 'acceptMachineVersions'
  | 'checkMachineAgentVersions'
  | 'recoverMachine'
>

export const machineActions = (set: StoreSet, get: StoreGet): MachineActions => ({
  async refreshMachines() {
    const platform = get().platform
    if (!platform) return
    try {
      const list = await platform.machines.list()
      set({ machines: Object.fromEntries(list.map((m) => [m.id, m])) })
    } catch {
      /* the host did not answer: the last list stays */
    }
  },

  async addMachine(spec) {
    const m = await get().platform!.machines.add(spec)
    set((s) => ({ machines: withAnswered(s.machines, m) }))
    return m
  },

  async machineSshHosts() {
    try {
      return await get().platform!.machines.sshHosts()
    } catch {
      return null
    }
  },

  async probeMachine(sshTarget) {
    try {
      return await get().platform!.machines.probe(sshTarget)
    } catch {
      return null
    }
  },

  async removeMachine(machineId) {
    await get().platform!.machines.remove(machineId)
    // Its sessions and projects leave with its own resync; the row goes now
    set((s) => ({ machines: omitKey(s.machines, machineId), machineAgentVersions: omitKey(s.machineAgentVersions, machineId) }))
  },

  async reconnectMachine(machineId) {
    try {
      const m = await get().platform!.machines.reconnect(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not reconnect: ${errorMessage(e)}` })
    }
  },

  async disconnectMachine(machineId) {
    try {
      const m = await get().platform!.machines.disconnect(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not disconnect: ${errorMessage(e)}` })
    }
  },

  async revokeMachineCredential(machineId, credentialId) {
    const platform = get().platform
    if (!platform) return
    try {
      const m = await platform.machines.revokeCredential(machineId, credentialId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not withdraw that access: ${errorMessage(e)}` })
    }
  },

  async setMachineAutoReconnect(machineId, autoReconnect) {
    try {
      const m = await get().platform!.machines.setAutoReconnect(machineId, autoReconnect)
      // The setting is the answer's: a `machine_status` sent before it may predate the change
      set((s) => ({ machines: { ...s.machines, [m.id]: { ...(s.machines[m.id] ?? m), autoReconnect: m.autoReconnect } } }))
      return true
    } catch (e) {
      set({ toast: `Could not change Auto reconnect: ${errorMessage(e)}` })
      return false
    }
  },

  async changeMachineInstall(machineId, kind, when) {
    const port = get().platform!.machines
    try {
      const r = kind === 'update' ? await port.update(machineId, when ? { when } : undefined) : await port[kind](machineId)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      // What an update that stopped working turns says it ended (#1399)
      if (kind === 'update' && 'note' in r && r.note) set({ toast: r.note })
      return true
    } catch (e) {
      const what = { install: 'Install', update: 'Update', rollback: 'Rollback', uninstall: 'Uninstall' }[kind]
      // An update that waits for sessions can outlast the call: the row says where it is (#1399)
      if (kind === 'update' && /timed out/i.test(errorMessage(e))) set({ toast: 'The update is still under way; the machine\'s row shows where it is' })
      else set({ toast: `${what} failed: ${errorMessage(e)}` })
      return false
    }
  },

  async cancelMachineUpdate(machineId) {
    const machines = get().platform?.machines
    if (!machines) return
    try {
      const m = await machines.cancelUpdate(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not cancel the update: ${errorMessage(e)}` })
    }
  },

  async setMachineAutostart(machineId, on) {
    try {
      const r = await get().platform!.machines.autostart(machineId, on)
      set((s) => ({ machines: withAnswered(s.machines, r.machine) }))
      return true
    } catch (e) {
      set({ toast: `Could not turn ${on ? 'on' : 'off'} starting at boot: ${errorMessage(e)}` })
      return false
    }
  },

  async setMachineAsks(machineId, on) {
    try {
      const machine = await get().platform!.machines.setAsks(machineId, on)
      set((s) => ({ machines: withAnswered(s.machines, machine) }))
      return true
    } catch (e) {
      set({ toast: `Could not turn ${on ? 'on' : 'off'} asks from that machine: ${errorMessage(e)}` })
      return false
    }
  },

  async machineActivity(machineId) {
    try {
      return await get().platform!.machines.activity(machineId)
    } catch {
      return null
    }
  },

  async acceptMachineVersions(machineId) {
    try {
      const m = await get().platform!.machines.acceptVersions(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not connect: ${errorMessage(e)}` })
    }
  },

  async checkMachineAgentVersions(machineId, force = false) {
    const platform = get().platform
    if (!platform) return
    try {
      const v = await platform.agents.versions(force, machineId)
      set((s) => ({ machineAgentVersions: { ...s.machineAgentVersions, [machineId]: v } }))
    } catch {
      // Away, or a host that does not know the machine parameter: the header stays quiet, as for this computer
    }
  },

  async recoverMachine(machineId) {
    const s = get()
    if (!s.platform) return
    const ofMachine = (x: { machine?: string | null }) => (x.machine ?? null) === machineId
    // Held live before: the candidates to wake, once the fresh list says they are not
    const wasLive = Object.values(s.sessions).filter((x) => ofMachine(x) && x.live)
    const asked = s.sessions
    const watch = watchLiveEvents()
    const platform = s.platform
    const [fresh, projects] = await Promise.all([
      platform.agents.listSessions().catch(() => null),
      platform.projects.list().catch(() => null),
    ]).finally(watch.stop)
    // docs/state-management.md §7: when a resync is whole, and when a machine is owed a read (#1611)
    const mirrored = (x: { machine?: string | null; unreachable?: boolean }) => ofMachine(x) && x.unreachable === true
    const whole = !!fresh && !!projects && !fresh.some(mirrored) && !projects.some(mirrored)
    if (whole) unrecoveredOf(platform).delete(machineId)
    else unrecoveredOf(platform).add(machineId)
    if (!fresh) return
    set((st) => {
      // docs/state-management.md §7, step 1: only this machine's rows move (#163)
      const { sessions, gone } = mergeListedSince(asked, st.sessions, fresh.filter(ofMachine), watch.touched, ofMachine)
      let nextProjects = st.projects
      if (projects) {
        const theirs = new Map(projects.filter(ofMachine).map((p) => [p.id, p]))
        nextProjects = {}
        for (const [id, p] of Object.entries(st.projects)) {
          if (!ofMachine(p)) nextProjects[id] = p
          else if (theirs.has(id)) nextProjects[id] = theirs.get(id)!
        }
        for (const [id, p] of theirs) if (!nextProjects[id]) nextProjects[id] = p
      }
      const forgotten = forgetSessions(st, gone)
      // A wake's failure note from a dropping link clears with the link back (#1840); a lock elsewhere's note stays
      const base = forgotten.wakeError ?? st.wakeError
      const wakeError = Object.fromEntries(Object.entries(base).filter(([id]) => !ofMachine(sessions[id] ?? {}) || st.wakeLocked[id]))
      return {
        sessions,
        ...forgotten,
        wakeError,
        projects: nextProjects,
        workingSince: trackWorkingSince(st.workingSince, sessions, Date.now()),
      }
    })
    replayPendingEvents(get)
    get().pruneFoldedGroups()
    // A remote's user-folder and project apps come and go with it
    void get().refreshExternalApps()
    // Its agent CLIs may have moved while it was away
    if (get().machineAgentVersions[machineId]) void get().checkMachineAgentVersions(machineId)

    // docs/state-management.md §7, step 2: the hub does not replay a remote's gap (#173)
    const holding = new Set(Object.keys(get().chat))
    const focused = get().focusedSessionId
    if (focused) holding.add(focused)
    for (const id of holding) {
      const cur = get().sessions[id]
      if (cur && ofMachine(cur)) void get().loadHistory(id)
    }

    // The toast counts only what this window wakes (`wakeable`)
    const toWake = wasLive.filter((x) => wakeable(get().sessions[x.id], get().machines))
    if (toWake.length === 0) return
    const name = machineNameOf(get().machines, machineId)
    set({ toast: `${name} is back — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    for (const x of toWake) await get().wake(x.id)
  },
})
