import { useStore } from '../../store/store.js'

/**
 * GUI slash commands (requested by a user on 2026-09-07).
 *
 * `/usage` is a client-side built-in command in the CLI, so there is no response for it in the
 * SDK protocol — sending it to a session leaves the agent nothing it can do. So for the names
 * listed here, pressing Enter in the composer **opens an app screen instead of sending the
 * message.** They stand alongside session commands in autocomplete, but the hint says where
 * they come from (opens in app).
 *
 * **Only intercepted when exactly the name is typed, nothing more.** If there is anything after
 * it, like `/usage whatever`, that may mean the person wants to say something to the session, so
 * it goes out as a normal message — the wider the interception net, the wider the surface for
 * the surprise of "I sent it and nothing happened".
 */
export type GuiCommand = {
  name: string
  description: string
  run: (ctx: { sessionId: string }) => void
}

export const GUI_COMMANDS: GuiCommand[] = [
  {
    name: 'usage',
    description: 'Plan limits & rate windows',
    run: () => useStore.getState().toggleUsage(true),
  },
  {
    name: 'model',
    description: 'Model, effort, permissions — this session',
    // A screen equivalent to the CLI's /model already exists — the settings menu below the composer
    run: ({ sessionId }) => useStore.getState().requestSettingsMenu(sessionId),
  },
  {
    name: 'settings',
    description: 'App settings',
    run: () => useStore.getState().toggleSettings(true),
  },
]

/**
 * Whether the text to send is a GUI command itself — true only for `/usage` (leading/trailing
 * whitespace allowed)
 */
export function guiCommandFor(text: string): GuiCommand | null {
  const m = /^\/([a-z][a-z-]*)$/.exec(text.trim())
  return m ? (GUI_COMMANDS.find((c) => c.name === m[1]) ?? null) : null
}
