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
    const [fresh, projects] = await Promise.all([
      s.platform.agents.listSessions().catch(() => null),
      s.platform.projects.list().catch(() => null),
    ]).finally(watch.stop)
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
      return now && !now.live && !isAway(now, get().machines)
    })
    if (toWake.length === 0) return
    const name = get().machines[machineId]?.name ?? machineId
    set({ toast: `${name} is back — resuming ${toWake.length} session${toWake.length > 1 ? 's' : ''}` })
    for (const x of toWake) await get().wake(x.id)
  },
})
