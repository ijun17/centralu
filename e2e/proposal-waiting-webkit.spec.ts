import { test } from '@playwright/test'
import { proposalWaitingTests } from './fixtures/proposal-waiting.js'

/** A pending assistant proposal (#703), in WebKit: the desktop app is WKWebView (see fixtures/proposal-waiting.ts). */
test.use({ browserName: 'webkit' })

proposalWaitingTests()
