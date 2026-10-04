import { test } from '@playwright/test'
import { agentNoticesTests } from './fixtures/agent-notices.js'

/**
 * Resets, notices and model switches the agent tools report (#304), in WebKit. The desktop app is WKWebView, and a
 * long notice has to wrap inside the conversation there too.
 */
test.use({ browserName: 'webkit' })

agentNoticesTests()
