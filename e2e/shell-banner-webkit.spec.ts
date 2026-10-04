import { test } from '@playwright/test'
import { shellBannerTests } from './fixtures/shell-banner.js'

/**
 * The shell's banner covers nothing, in WebKit. The desktop app is WKWebView, and the defect it
 * guards against was seen there (#326, see fixtures/shell-banner.ts).
 */
test.use({ browserName: 'webkit' })

shellBannerTests()
