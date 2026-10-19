import { initialSession } from '@cc/core'
import type { ToolName } from '@cc/protocol'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { syncBadge } from './events/notices.js'
import { replayPendingEvents } from './sessionList.js'

/**
 * The orchestrator: opening its screen without starting it, starting it with the first question
 * (#63), the intro's choice of tool, and the MCP-server and skill proposals it leaves for the person.
 */

/** The store's actions for the orchestrator and its proposals */
type OrchestratorActions = Pick<
  AppState,
  | 'openOrchestrator'
  | 'askOrchestrator'
  | 'completeIntro'
  | 'chooseOrchestratorTool'
  | 'refreshMcpProposals'
  | 'resolveMcpProposal'
  | 'refreshSkillProposals'
  | 'resolveSkillProposal'
>

/** Records the tool the orchestrator will be born with; a failure is toasted */
async function recordChoice(set: StoreSet, get: StoreGet, tool: ToolName): Promise<boolean> {
  try {
    await get().platform?.agents.configureOrchestrator(tool)
    set({ orchestratorTool: tool })
    return true
  } catch (e) {
    set({ toast: `Could not save the choice: ${(e as Error).message}` })
    return false
  }
}

export const orchestratorActions = (set: StoreSet, get: StoreGet): OrchestratorActions => ({
  async openOrchestrator() {
    const platform = get().platform
    if (!platform) return
    /*
     * The screen changes first. Even if the lookup is slow, if nothing happens in the meantime, the
     * person who clicked assumes the button is dead — the same reason a message is marked "working"
     * the instant it is sent.
     */
    // Landing here also counts as having passed the intro (the same reason as `setView`, #63)
    set({ view: 'orchestrator', introSeen: true, overlay: null })
    get().saveWorkspace()
    try {
      /*
       * **Only asks — never creates** (#63, deferred startup). Opening the screen and creating the
       * process are now separate: if there is none, an empty conversation (with suggested-question
       * cards) stands, and creation happens only in `askOrchestrator`, at the moment the first
       * question is asked. Creating it here as before would bring up a tool process for a person who
       * never even asked for it.
       */
      const info = await platform.agents.orchestratorPeek()
      if (!info) return
      set((s) => ({
        orchestratorId: info.id,
        sessions: {
          ...s.sessions,
          [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
        },
      }))
      // This is also a point where a session is first registered — replays any events held in the pen
      replayPendingEvents(get)
      if (!get().chat[info.id]) void get().loadHistory(info.id)
    } catch (e) {
      // If it could not be opened, the view reverts — the worst outcome is leaving an empty screen up with no explanation
      set({ view: 'focus', toast: `Could not open the orchestrator: ${(e as Error).message}` })
    }
  },

  async askOrchestrator(text) {
    const platform = get().platform
    if (!platform) return false
    let id = get().orchestratorId
    if (!id) {
      // The first question is the birth itself (#63) — the process comes up only the instant a card is pressed
      set({ orchestratorWaking: true })
      try {
        const info = await platform.agents.orchestrator()
        set((s) => ({
          orchestratorId: info.id,
          sessions: {
            ...s.sessions,
            [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
          },
        }))
        replayPendingEvents(get)
        id = info.id
      } catch (e) {
        set({ toast: `Could not start the orchestrator: ${(e as Error).message}` })
        return false
      } finally {
        set({ orchestratorWaking: false })
      }
    }
    // A failure from this point on has `send` put the text back into the composer (now the draft of a real session)
    await get().send(id, text)
    return true
  },

  async completeIntro(tool) {
    /*
     * The screen is passed through first — a failed setting save must not trap the person on the intro
     * screen (it runs on the default, claude). Clicking the card only records the setting; no process
     * comes up.
     */
    set({ introSeen: true })
    get().saveWorkspace()
    await recordChoice(set, get, tool)
    void get().openOrchestrator()
  },

  async chooseOrchestratorTool(tool) {
    const platform = get().platform
    if (!platform) return false
    let id = get().orchestratorId
    if (!id) {
      // This run may not have opened it: the host knows whether a session exists, and a recorded choice is not read once one does
      try {
        id = (await platform.agents.orchestratorPeek())?.id ?? null
      } catch (e) {
        set({ toast: `Could not switch the agent: ${(e as Error).message}` })
        return false
      }
    }
    return id ? get().switchTool(id, tool) : recordChoice(set, get, tool)
  },

  async refreshMcpProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.mcpProposals()
      set({ mcpProposals: r.proposals })
      syncBadge(get)
    } catch {
      /* The app is fine even if the suggestion list fails to load — the next event calls it again */
    }
  },

  async resolveMcpProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveMcpProposal(name, approve)
      set({
        toast: approve
          ? `Installing ${name} — restarting the orchestrator so it can use the new tools`
          : `Dismissed MCP proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshMcpProposals()
  },

  async refreshSkillProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.skillProposals()
      set({ skillProposals: r.proposals })
      syncBadge(get)
    } catch {
      /* The app is fine even if this fails to load — the next event calls it again */
    }
  },

  async resolveSkillProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveSkillProposal(name, approve)
      set({
        toast: approve
          ? `Skill saved: ${name} — restarting the orchestrator so it takes effect`
          : `Dismissed skill proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${(e as Error).message}` })
    }
    await get().refreshSkillProposals()
  },
})
