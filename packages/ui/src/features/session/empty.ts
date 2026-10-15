import type { SessionSummary } from '@cc/core'
import type { ChatItem } from '../../store/store.js'

/**
 * A selector that creates a new array every time destabilizes the zustand snapshot and causes
 * infinite re-renders
 */
export const EMPTY_CHAT: ChatItem[] = []
export const EMPTY_QUESTIONS: SessionSummary['pendingQuestions'] = []
