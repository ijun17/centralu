import { test } from '@playwright/test'
import { centraluCallTests } from './fixtures/centralu-calls.js'

/** Centralu's own tool calls (#730), in WebKit: the desktop app is WKWebView. */
test.use({ browserName: 'webkit' })

centraluCallTests()
