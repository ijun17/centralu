import { test } from '@playwright/test'
import { inboxDoneTests } from './fixtures/inbox-done.js'

/** The inbox's Done (#669), in WebKit: the desktop app is WKWebView (see fixtures/inbox-done.ts). */
test.use({ browserName: 'webkit' })

inboxDoneTests()
