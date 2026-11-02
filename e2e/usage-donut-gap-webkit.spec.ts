import { test } from '@playwright/test'
import { usageDonutGapTests } from './fixtures/usage-donut-gap.js'

/** The usage donuts' spacing in WebKit, the engine the desktop app runs in */
test.use({ browserName: 'webkit' })

usageDonutGapTests()
