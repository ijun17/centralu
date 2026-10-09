import { test } from '@playwright/test'
import { remoteMachineToolsTests } from './fixtures/remote-machine-tools.js'

/** The same, in WebKit: the desktop app is WKWebView (#82) */
test.use({ browserName: 'webkit' })

remoteMachineToolsTests()
