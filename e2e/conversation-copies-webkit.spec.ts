import { test } from '@playwright/test'
import { conversationCopiesTests } from './fixtures/conversation-copies.js'

/**
 * Each row of the conversation once in the DOM (#64), in WebKit — the engine of the desktop app,
 * where the copies were reported. See fixtures/conversation-copies.ts.
 */
test.use({ browserName: 'webkit' })

conversationCopiesTests()
