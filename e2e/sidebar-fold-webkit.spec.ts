import { test } from '@playwright/test'
import { sidebarFoldTests, orchestratorFoldTests } from './fixtures/sidebar-fold.js'

/**
 * The sidebar folds (#1605), in WebKit. The desktop app is WKWebView, and a track that grows from 0fr to 1fr has to
 * interpolate there without a jump.
 */
test.use({ browserName: 'webkit' })

sidebarFoldTests()
orchestratorFoldTests()
