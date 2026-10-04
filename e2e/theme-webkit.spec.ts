import { test } from '@playwright/test'
import { themeTests } from './fixtures/theme.js'

/**
 * Themes (#312) in WebKit, the engine the desktop app runs in: prefers-color-scheme, inline custom
 * properties on <html> and color-scheme are where the two engines could disagree.
 */
test.use({ browserName: 'webkit' })

themeTests()
