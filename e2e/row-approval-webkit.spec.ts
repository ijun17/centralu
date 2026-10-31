import { test } from '@playwright/test'
import { rowApprovalTests } from './fixtures/row-approval.js'

/** Answering an approval from the waiting list's row (#543), in WebKit: the desktop app is WKWebView (see fixtures/row-approval.ts). */
test.use({ browserName: 'webkit' })

rowApprovalTests()
