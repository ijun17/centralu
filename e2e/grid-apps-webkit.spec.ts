import { test } from '@playwright/test'
import { gridAppTests } from './fixtures/grid-apps.js'

/**
 * Apps on the grid (#288), in WebKit. The desktop app is WKWebView: an app's view is laid over its panel by measuring
 * the panel, and a drag goes into a frame whatever the frame's pointer-events say — places where the two engines can
 * disagree (see fixtures/grid-apps.ts).
 */
test.use({ browserName: 'webkit' })

gridAppTests()
