import { initialSession, stampProposals } from '@cc/core'
import { errorMessage, type ToolName } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { syncBadge } from './events/notices.js'
import { replayPendingEvents } from './sessionList.js'

type AssistantActions = Pick<
  AppState,
  | 'openAssistant'
  | 'askAssistant'
  | 'completeIntro'
  | 'chooseAssistantTool'
  | 'refreshMcpProposals'
  | 'resolveMcpProposal'
  | 'refreshSkillProposals'
  | 'resolveSkillProposal'
>

/**
 * Every way onto the Assistant's screen goes through this (#1647); one that knows the session passes it, and the button
 * learns it from the host a moment later. Landing here passes the intro, as in `setView` (#63).
 */
export function assistantScreen(id?: string): Pick<AppState, 'view' | 'introSeen' | 'overlay'> & Partial<Pick<AppState, 'assistantId'>> {
  return { view: 'assistant', introSeen: true, overlay: null, ...(id ? { assistantId: id } : {}) }
}

async function recordChoice(set: StoreSet, get: StoreGet, tool: ToolName): Promise<boolean> {
  try {
    await get().platform?.agents.configureAssistant(tool)
    set({ assistantTool: tool })
    return true
  } catch (e) {
    set({ toast: `Could not save the choice: ${errorMessage(e)}` })
    return false
  }
}

export const assistantActions = (set: StoreSet, get: StoreGet): AssistantActions => ({
  async openAssistant() {
    const platform = get().platform
    if (!platform) return
    // The screen changes first: a click that shows nothing during a slow lookup reads as a dead button
    set(assistantScreen())
    get().saveWorkspace()
    try {
      // Only asks, never creates (#63): the process starts at the first question (`askAssistant`)
      const info = await platform.agents.assistantPeek()
      if (!info) return
      set((s) => ({
        assistantId: info.id,
        sessions: {
          ...s.sessions,
          [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
        },
      }))
      replayPendingEvents(get)
      if (!get().chat[info.id]) void get().loadHistory(info.id)
    } catch (e) {
      // Reverted and said, not an empty screen with no word
      set({ view: 'focus', toast: `Could not open the Assistant: ${errorMessage(e)}` })
    }
  },

  async askAssistant(text) {
    const platform = get().platform
    if (!platform) return false
    let id = get().assistantId
    if (!id) {
      set({ assistantWaking: true })
      try {
        const info = await platform.agents.assistant()
        set((s) => ({
          assistantId: info.id,
          sessions: {
            ...s.sessions,
            [info.id]: s.sessions[info.id] ?? initialSession({ ...info, projectId: null }),
          },
        }))
        replayPendingEvents(get)
        id = info.id
      } catch (e) {
        set({ toast: `Could not start the Assistant: ${errorMessage(e)}` })
        return false
      } finally {
        set({ assistantWaking: false })
      }
    }
    // From here a failure has `send` put the text back into the composer
    await get().send(id, text)
    return true
  },

  async completeIntro(tool) {
    // Passed first: a failed save must not trap the person on the intro (the default, claude, runs)
    set({ introSeen: true })
    get().saveWorkspace()
    await recordChoice(set, get, tool)
    void get().openAssistant()
  },

  async chooseAssistantTool(tool) {
    const platform = get().platform
    if (!platform) return false
    let id = get().assistantId
    if (!id) {
      // The host knows whether a session exists, and a recorded choice is not read once one does
      try {
        id = (await platform.agents.assistantPeek())?.id ?? null
      } catch (e) {
        set({ toast: `Could not switch the agent: ${errorMessage(e)}` })
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
      set((s) => ({ mcpProposals: stampProposals(s.mcpProposals, r.proposals, Date.now()) }))
      syncBadge(get)
    } catch {
      /* The next event reads it again */
    }
  },

  async resolveMcpProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveMcpProposal(name, approve)
      set({
        toast: approve
          ? `Installing ${name} — restarting the Assistant so it can use the new tools`
          : `Dismissed MCP proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${errorMessage(e)}` })
    }
    await get().refreshMcpProposals()
  },

  async refreshSkillProposals() {
    const platform = get().platform
    if (!platform) return
    try {
      const r = await platform.agents.skillProposals()
      set((s) => ({ skillProposals: stampProposals(s.skillProposals, r.proposals, Date.now()) }))
      syncBadge(get)
    } catch {
      /* The next event reads it again */
    }
  },

  async resolveSkillProposal(name, approve) {
    const platform = get().platform
    if (!platform) return
    try {
      await platform.agents.resolveSkillProposal(name, approve)
      set({
        toast: approve
          ? `Skill saved: ${name} — restarting the Assistant so it takes effect`
          : `Dismissed skill proposal: ${name}`,
      })
    } catch (e) {
      set({ toast: `Could not resolve the proposal: ${errorMessage(e)}` })
    }
    await get().refreshSkillProposals()
  },
})
