import { test } from '@playwright/test'
import { popoverDragTests } from './fixtures/popover-drag.js'

/**
 * The same popovers in WebKit. The desktop app on macOS is WKWebView, and mousedown, click and React's portal bubbling
 * are each run by the engine.
 */
test.use({ browserName: 'webkit' })

popoverDragTests()
