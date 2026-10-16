import { test } from '@playwright/test'
import { popoverDismissTests } from './fixtures/popover-dismiss.js'

/** Popover dismissal (#428), in WebKit: the desktop app is WKWebView (see fixtures/popover-dismiss.ts). */
test.use({ browserName: 'webkit' })

popoverDismissTests()
