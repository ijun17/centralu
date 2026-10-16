import { test } from '@playwright/test'
import { virtualCopyTests } from './fixtures/virtual-copy.js'

/** Copy and ⌘A in the code viewer and the diff (#428), in WebKit: the desktop app is WKWebView (see fixtures/virtual-copy.ts). */
test.use({ browserName: 'webkit' })

virtualCopyTests()
