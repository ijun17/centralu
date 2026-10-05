import { test } from '@playwright/test'
import { builderLinkTests } from './fixtures/builder-link.js'

/**
 * "Show the conversation" under an app's view, in WebKit. The desktop app is WKWebView, and a view on the grid or the
 * project screen is laid over its panel by measuring it (see fixtures/builder-link.ts).
 */
test.use({ browserName: 'webkit' })

builderLinkTests()
