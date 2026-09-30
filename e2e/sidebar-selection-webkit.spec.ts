import { test } from '@playwright/test'
import { sidebarSelectionTests } from './fixtures/sidebar-selection.js'

/**
 * The sidebar's open-project tint and row marks, in WebKit. The desktop app is WKWebView, and the name row's band is
 * held in place by a negative margin — layout the two engines compute separately (see fixtures/sidebar-selection.ts).
 */
test.use({ browserName: 'webkit' })

sidebarSelectionTests()
