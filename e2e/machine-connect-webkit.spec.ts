import { test } from '@playwright/test'
import { machineConnectTests } from './fixtures/machine-connect.js'

/**
 * When this computer reconnects to a linked machine (#1341), in WebKit: the desktop app is WKWebView (see fixtures/machine-connect.ts).
 */
test.use({ browserName: 'webkit' })

machineConnectTests()
