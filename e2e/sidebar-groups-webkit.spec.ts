import { test } from '@playwright/test'
import { sidebarGroupTests } from './fixtures/sidebar-groups.js'

/**
 * The sidebar's indentation and folding, in WebKit. The desktop app is WKWebView, and the chevron stands in a gutter
 * outside its row's box (see fixtures/sidebar-groups.ts).
 */
test.use({ browserName: 'webkit' })

sidebarGroupTests()
