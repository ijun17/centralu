import { test } from '@playwright/test'
import { toolSetupTests } from './fixtures/tool-setup.js'

/** A tool's setup line and the top bar's error donuts (#59), in WebKit: the desktop app is WKWebView */
test.use({ browserName: 'webkit' })

toolSetupTests()
