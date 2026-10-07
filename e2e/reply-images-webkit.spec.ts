import { test } from '@playwright/test'
import { replyImageTests } from './fixtures/reply-images.js'

/**
 * A local image in an agent's reply, in WebKit. The desktop app is WKWebView, and the broken-image mark this replaces
 * was WebKit's; how a data URL decodes and sizes inside a reply is the engine's to answer.
 */
test.use({ browserName: 'webkit' })

replyImageTests()
