import { test } from '@playwright/test'
import { appThemeTests, liveTransparencyTest } from './fixtures/app-theme.js'

/**
 * The theme reaching app views (#312 step 6) in WebKit, the engine the desktop app runs in. Its
 * scrollbar pseudo-elements and its frame backdrops are where the two engines could disagree.
 */
test.use({ browserName: 'webkit' })

appThemeTests()
liveTransparencyTest()
