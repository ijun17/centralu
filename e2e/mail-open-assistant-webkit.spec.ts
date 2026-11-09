import { test } from '@playwright/test'
import { mailOpenAssistantTests } from './fixtures/mail-open-assistant.js'

/** Opening the Assistant from a mail (#1647), in WebKit: the desktop app is WKWebView (see fixtures/mail-open-assistant.ts). */
test.use({ browserName: 'webkit' })

mailOpenAssistantTests()
