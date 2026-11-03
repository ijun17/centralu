import { test } from '@playwright/test'
import { updateResyncTests } from './fixtures/update-resync.js'

/** The same, in WebKit: the desktop app is WKWebView (#1902) */
test.use({ browserName: 'webkit' })

updateResyncTests()
