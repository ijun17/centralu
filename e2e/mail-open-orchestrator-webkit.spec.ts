import { test } from '@playwright/test'
import { mailOpenOrchestratorTests } from './fixtures/mail-open-orchestrator.js'

/** Opening the orchestrator from a mail (#1647), in WebKit: the desktop app is WKWebView (see fixtures/mail-open-orchestrator.ts). */
test.use({ browserName: 'webkit' })

mailOpenOrchestratorTests()
