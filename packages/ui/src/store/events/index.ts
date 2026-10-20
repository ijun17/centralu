import type { AppState, StoreGet, StoreSet } from '../state.js'
import { liveEventWatchers } from '../sessionList.js'
import { appEvent, appViewEvent } from './apps.js'
import { conversationEvent, subagentStepEvent } from './conversation.js'
import { listEvent } from './lists.js'
import { machineEvent } from './machines.js'
import { noticeEvent } from './notices.js'
import { sessionEvent, sessionListEvent } from './sessions.js'
import { updateEvent } from './updates.js'

/**
 * `dispatchEvent`: every event the host sends goes through here. App-wide events first, then the
 * session guard, then a session's own life, its notices and its conversation, each in its family's
 * file. The order is the order these were handled in when they were one function.
 */
export const eventActions = (set: StoreSet, get: StoreGet): Pick<AppState, 'dispatchEvent'> => ({
  dispatchEvent(e) {
    /*
     * Events that do not belong to a session are handled **before the session guard** (issue #43).
     *
     * The `if (!sessionId) return` below is the widest door in this file, and anything caught by it
     * vanishes silently — placing the update status handling after it would make the host's message
     * arrive and do nothing, the worst kind of defect to trace.
     */
    if (updateEvent(e, set, get) || listEvent(e, set, get) || machineEvent(e, set, get) || appEvent(e, set, get) || subagentStepEvent(e, set, get)) return

    const sessionId = e.sessionId
    if (!sessionId) return
    // A recovery reading the session list keeps what this event says over an older row (`mergeListedSince`)
    for (const touched of liveEventWatchers) if (!touched.has(sessionId)) touched.set(sessionId, new Set())

    if (sessionEvent(e, sessionId, set, get)) return
    const announced = noticeEvent(e, sessionId, set, get)
    if (sessionListEvent(e, sessionId, set, get) || appViewEvent(e, sessionId, set, get)) return
    conversationEvent(e, sessionId, announced, set, get)
  },
})
