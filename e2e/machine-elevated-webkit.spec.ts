import { test } from '@playwright/test'
import { machineElevatedTests } from './fixtures/machine-elevated.js'

/**
 * Settings → Machines' warning for an elevated host (#702), in WebKit: the desktop app is WKWebView (see
 * fixtures/machine-elevated.ts).
 */
test.use({ browserName: 'webkit' })

machineElevatedTests()
