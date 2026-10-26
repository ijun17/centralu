import { test } from '@playwright/test'
import { usageDonutStatesTests } from './fixtures/usage-donut-states.js'

/** The usage donut's states in WebKit, the engine the desktop app runs in (#1616): its SVG transitions are where the engines could disagree */
test.use({ browserName: 'webkit' })

usageDonutStatesTests()
