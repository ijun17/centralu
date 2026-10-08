import { test } from '@playwright/test'
import { composerFocusTests } from './fixtures/composer-focus.js'

/**
 * The composer keeps the keyboard (#115), in WebKit: the desktop app is WKWebView, and a hidden app
 * view keeping focus inside its frame is WebKit's behaviour (see fixtures/composer-focus.ts).
 */
test.use({ browserName: 'webkit' })

composerFocusTests()
