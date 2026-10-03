import { autoFollowTests } from './fixtures/auto-follow.js'

/**
 * Following the bottom of the conversation, and letting go when the person scrolls up. The
 * scenarios live in fixtures/auto-follow.ts, which auto-follow-webkit.spec.ts runs again in WebKit.
 */
autoFollowTests()
