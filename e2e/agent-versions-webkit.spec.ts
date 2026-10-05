import { test } from '@playwright/test'
import { agentVersionsTests } from './fixtures/agent-versions.js'

/**
 * A session that runs an older agent CLI than the one installed (#297), in WebKit. The desktop app is WKWebView, and the
 * line shares the header's single row with the session's name and buttons.
 */
test.use({ browserName: 'webkit' })

agentVersionsTests()
