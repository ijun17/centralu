import type { SessionSummary } from '@cc/core'
import type { ChatItem } from '../../store/store.js'

/** A selector returning a new array each time makes zustand re-render without end */
export const EMPTY_CHAT: ChatItem[] = []
export const EMPTY_QUESTIONS: SessionSummary['pendingQuestions'] = []
