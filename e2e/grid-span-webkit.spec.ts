import { test } from '@playwright/test'
import { gridSpanTests } from './fixtures/grid-span.js'

/**
 * An app panel's span on the grid (#306), in WebKit — the desktop app's engine. The app's view is laid over its panel
 * by measuring the panel, so a panel that widens or moves is where the two engines can disagree.
 */
test.use({ browserName: 'webkit' })

gridSpanTests()
