import { test } from '@playwright/test'
import { machineCredentialsTests } from './fixtures/machine-credentials.js'

/** Settings → Machines' other full credentials (#1405), in WebKit: the desktop app is WKWebView */
test.use({ browserName: 'webkit' })

machineCredentialsTests()
