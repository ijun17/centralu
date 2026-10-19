import { test } from '@playwright/test'
import { machineAsksTests } from './fixtures/machine-asks.js'

/** The switch and the card of #550, in WebKit: the desktop app is WKWebView, and the card answers by keyboard */
test.use({ browserName: 'webkit' })

machineAsksTests()
