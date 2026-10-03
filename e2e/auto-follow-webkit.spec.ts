import { test } from '@playwright/test'
import { autoFollowTests } from './fixtures/auto-follow.js'

/**
 * Following the bottom of the conversation, in WebKit. The desktop app is WKWebView, and the
 * release nobody asked for (a large answer landing in one burst) only ever showed in WebKit —
 * see fixtures/auto-follow.ts.
 */
test.use({ browserName: 'webkit' })

autoFollowTests()
