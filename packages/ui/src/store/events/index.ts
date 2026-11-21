import type { AppState, StoreGet, StoreSet } from '../state.js'
import { liveEventWatchers } from '../sessionList.js'
import { appEvent, appViewEvent } from './apps.js'
import { conversationEvent, subagentStepEvent } from './conversation.js'
import { rereadFor } from './rereads.js'
import { mailEvent } from '../mail.js'
import { machineEvent } from './machines.js'
import { noticeEvent } from './notices.js'
import { sessionEvent, sessionListEvent } from './sessions.js'
import { updateEvent } from './updates.js'

// A handler that answers true ends the dispatch, so the order of the calls is part of the behavior.
export const eventActions = (set: StoreSet, get: StoreGet): Pick<AppState, 'dispatchEvent'> => ({
  dispatchEvent(e, id) {
    // App-wide events go before the session guard, which drops anything without a session silently (#43)
    if (updateEvent(e, set, get) || rereadFor(e, set, get) || machineEvent(e, set, get) || mailEvent(e, set, get) || appEvent(e, set) || subagentStepEvent(e, set, get)) return

    const sessionId = e.sessionId
    if (!sessionId) return
    // A recovery reading the session list keeps what this event says over an older row (`mergeListedSince`)
    for (const touched of liveEventWatchers) if (!touched.has(sessionId)) touched.set(sessionId, new Set())

    if (sessionEvent(e, sessionId, set, get)) return
    noticeEvent(e, sessionId, set, get, id)
    if (sessionListEvent(e, sessionId, set, get) || appViewEvent(e, sessionId, set, get)) return
    conversationEvent(e, sessionId, set, get, id)
  },
})
