import { test } from '@playwright/test'
import { linkedHostsTests } from './fixtures/linked-hosts-scenarios.js'
import { linkedHostsUiTests } from './fixtures/linked-hosts-ui-scenarios.js'

/** The same, in WebKit: the desktop app is WKWebView (#82) */
test.use({ browserName: 'webkit' })

linkedHostsTests()
linkedHostsUiTests()
