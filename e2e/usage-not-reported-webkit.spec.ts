import { test } from '@playwright/test'
import { usageNotReportedTests } from './fixtures/usage-not-reported.js'

/** The usage panel of a tool with no limits in WebKit, the engine the desktop app runs in (#1623) */
test.use({ browserName: 'webkit' })

usageNotReportedTests()
