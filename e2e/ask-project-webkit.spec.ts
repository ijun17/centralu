import { test } from '@playwright/test'
import { askProjectTests } from './fixtures/ask-project.js'

/**
 * One project asking another (#371), in WebKit. The desktop app is WKWebView: the consent card answers by keyboard and
 * the link cards move focus between sessions, which the two engines run separately.
 */
test.use({ browserName: 'webkit' })

askProjectTests()
