import { test } from '@playwright/test'
import { composerThumbnailTests } from './fixtures/composer-thumbnails.js'

/**
 * The composer's thumbnails (#284), in WebKit. The desktop app is WKWebView, and how an image decodes, fails to
 * decode, and sizes inside a fixed-height row is the engine's to answer.
 */
test.use({ browserName: 'webkit' })

composerThumbnailTests()
