import { test } from '@playwright/test'
import { firstPaintTests } from './fixtures/first-paint.js'

/** The first paint (#340) in WebKit, the engine the desktop app runs in */
test.use({ browserName: 'webkit' })

firstPaintTests()
