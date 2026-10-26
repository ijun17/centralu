import { errorMessage, type MachineInfo } from '@cc/protocol'
import { isAway } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { omitKey } from './patch.js'
import { forgetSessions, mergeListedSince, replayPendingEvents, trackWorkingSince, watchLiveEvents } from './sessionList.js'

/**
 * Linked machines (#82): their list, adding, linking and removing one, what is installed there, and a
 * machine's own recovery when it comes back.
 */

/**
 * A machine row from the answer to `machines.add/reconnect/acceptVersions`, kept only when no `machine_status` got there
 * first (#82). The link moves on its own before the answer leaves the hub: `add` answers `connecting` while the version
 * check has already broadcast `versions_differ` (measured in e2e, the event arrived first). Writing the answer over the
 * event would leave the row saying connecting until the next change, which for a held link never comes.
 */
function withAnswered(machines: Record<string, MachineInfo>, m: MachineInfo): Record<string, MachineInfo> {
  return machines[m.id] ? machines : { ...machines, [m.id]: m }
}

/**
 * The machines whose resync is not complete (#1611): its list read failed, or the hub answered a list from its mirror
 * while the link was up. Held per platform (a new one starts clean) and read when a `machine_status` says the machine is
 * connected, so what a resync could not read is asked again at the next word the hub has about that machine instead of
 * waiting for the next connect.
 */
const unrecovered = new WeakMap<object, Set<string>>()
const unrecoveredOf = (platform: object): Set<string> => {
  let set = unrecovered.get(platform)
  if (!set) unrecovered.set(platform, (set = new Set()))
  return set
}

/**
 * Whether a machine's resync has left something unread, to be read again at its next `machine_status` that finds it
 * connected (see `unrecovered`). A transition into connected is not asked: the hub sends `machine_resync` right after it.
 */
export function resyncOwed(platform: object | null, machineId: string): boolean {
  return platform !== null && (unrecovered.get(platform)?.has(machineId) ?? false)
}

/**
 * The machines that are connected and whose rows still carry the hub's mirror mark (#1611): the list that wrote it was
 * read while the link was down or failing, and no resync has replaced it. They are read again where a list is taken
 * whole (attach, a reconnect to the hub), since that list can land after the machine's own resync.
 */
export function machinesHoldingMirror(s: Pick<AppState, 'machines' | 'sessions' | 'projects'>): string[] {
  const ids = new Set<string>()
  for (const row of [...Object.values(s.sessions), ...Object.values(s.projects)]) {
    if (row.machine && row.unreachable && s.machines[row.machine]?.status === 'connected') ids.add(row.machine)
  }
  return [...ids]
}

/** The store's actions for linked machines */
type MachineActions = Pick<
  AppState,
  | 'refreshMachines'
  | 'addMachine'
  | 'machineSshHosts'
  | 'probeMachine'
  | 'removeMachine'
  | 'reconnectMachine'
  | 'disconnectMachine'
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
      /* a host from before linked machines: none */
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
      set({ toast: `Could not reconnect: ${(e as Error).message}` })
    }
  },

  async disconnectMachine(machineId) {
    try {
      const m = await get().platform!.machines.disconnect(machineId)
      set((s) => ({ machines: withAnswered(s.machines, m) }))
    } catch (e) {
      set({ toast: `Could not disconnect: ${(e as Error).message}` })
    }
  },

  async setMachineAutoReconnect(machineId, autoReconnect) {
    try {
      const m = await get().platform!.machines.setAutoReconnect(machineId, autoReconnect)
      // The setting is the answer's: a `machine_status` sent before it may predate the change
      set((s) => ({ machines: { ...s.machines, [m.id]: { ...(s.machines[m.id] ?? m), autoReconnect: m.autoReconnect, connect: m.connect } } }))
      return true
    } catch (e) {
      set({ toast: `Could not change Auto reconnect: ${(e as Error).message}` })
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
      set({ toast: `Could not turn ${on ? 'on' : 'off'} starting at boot: ${(e as Error).message}` })
      return false
    }
  },

  async setMachineAsks(machineId, on) {
    try {
      const machine = await get().platform!.machines.setAsks(machineId, on)
      set((s) => ({ machines: withAnswered(s.machines, machine) }))
      return true
    } catch (e) {
      set({ toast: `Could not turn ${on ? 'on' : 'off'} asks from that machine: ${(e as Error).message}` })
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
      set({ toast: `Could not connect: ${(e as Error).message}` })
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
    /*
     * Whole only when both lists were read and the hub asked the machine for each. A row still marked while the machine
     * is connected means the hub's call to it failed while the link stayed up. Either way the machine is owed a read at
     * its next `machine_status` (#1611); the rows the failed read left are not dimmed meanwhile (`isAway` follows the
     * machine's row alone).
     */
    const mirrored = (x: { machine?: string | null; unreachable?: boolean }) => ofMachine(x) && x.unreachable === true
    const whole = !!fresh && !!projects && !fresh.some(mirrored) && !projects.some(mirrored)
    if (whole) unrecoveredOf(platform).delete(machineId)
    else unrecoveredOf(platform).add(machineId)
    if (!fresh) return
    set((st) => {
      /*
       * Only this machine's rows move. Every other row keeps its object, so nothing about this computer's sessions or
       * another machine's re-renders or loses what the reducer derived. A row of this machine the fresh list no
       * longer has (deleted there, or the machine was unlinked) leaves; a new one joins at the end. What changed
       * while the list was out is kept over its older rows, as in the reconnect recovery (`mergeListedSince`).
       * What a session that left kept is cleared as `session_deleted` clears it (#163).
       */
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
      return {
        sessions,
        ...forgetSessions(st, gone),
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

    /*
     * The events of the gap are not replayed through the hub (protocol.md, `machine_resync`): every conversation of
     * this machine that is open is read again, the same way a host resync reads every one held (#173).
     */
    const holding = new Set(Object.keys(get().chat))
    const focused = get().focusedSessionId
    if (focused) holding.add(focused)
    for (const id of holding) {
      const cur = get().sessions[id]
      if (cur && ofMachine(cur)) void get().loadHistory(id)
    }

    const toWake = wasLive.filter((x) => {
      const now = get().sessions[x.id]
      // Not a row the hub still lists from its mirror: its `live` is last heard, not a fact (#1611)
      return now && !now.live && !now.unreachable && !isAway(now, get().machines)
    })
    if (toWake.length === 0) return
    const name = get().machines[machineId]?.name ?? machineId
    set({ toast: `${name} is back — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    for (const x of toWake) await get().wake(x.id)
  },
})
