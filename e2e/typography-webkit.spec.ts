import { test } from '@playwright/test'
import { typographyTests } from './fixtures/typography.js'

/**
 * Fonts, line height and the text size (#312 step 5) in WebKit, the engine the desktop app runs in:
 * the root zoom, inline custom properties on <html> and xterm's font are where the engines could differ.
 */
test.use({ browserName: 'webkit' })

typographyTests()
