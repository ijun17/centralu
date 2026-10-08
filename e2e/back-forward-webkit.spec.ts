import { test } from '@playwright/test'
import { backForwardTests } from './fixtures/back-forward.js'

/**
 * Back and forward between screens (#374), in WebKit: the desktop app is WKWebView (see fixtures/back-forward.ts).
 */
test.use({ browserName: 'webkit' })

backForwardTests()
