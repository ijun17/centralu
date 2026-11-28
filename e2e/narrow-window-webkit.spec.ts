import { test } from '@playwright/test'
import { narrowWindowTests } from './fixtures/narrow-window.js'

/** A 420 px window (#2455), in WebKit: the desktop app is WKWebView (see fixtures/narrow-window.ts). */
test.use({ browserName: 'webkit' })

narrowWindowTests()
