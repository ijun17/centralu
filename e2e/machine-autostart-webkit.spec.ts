import { test } from '@playwright/test'
import { machineAutostartTests } from './fixtures/machine-autostart.js'

/**
 * Settings → Machines' start-at-boot switch (#82), in WebKit: the desktop app is WKWebView (see fixtures/machine-autostart.ts).
 */
test.use({ browserName: 'webkit' })

machineAutostartTests()
