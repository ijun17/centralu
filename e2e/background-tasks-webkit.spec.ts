import { test } from '@playwright/test'
import { backgroundTasksTests } from './fixtures/background-tasks.js'

/**
 * A session's background tasks on screen (#290), in WebKit. The desktop app is WKWebView, and the list is a popover laid
 * over the header — layout and outside-click handling the two engines run separately.
 */
test.use({ browserName: 'webkit' })

backgroundTasksTests()
