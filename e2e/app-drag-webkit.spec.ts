import { test } from '@playwright/test'
import { appDragTests } from './fixtures/app-drag.js'

/**
 * An item dragged out of an app view into a composer (#308), in WebKit. The desktop app is WKWebView, and the two
 * engines report a frame's `dragend` in different coordinates (app-frame/dragRelay.ts), so the drop has to land in
 * both.
 */
test.use({ browserName: 'webkit' })

appDragTests()
