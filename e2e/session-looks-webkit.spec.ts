import { test } from '@playwright/test'
import { sessionLookTests } from './fixtures/session-looks.js'

/** The four looks (#736) in WebKit, the engine the desktop app runs in: dashed borders and the border box are drawn by it. */
test.use({ browserName: 'webkit' })

sessionLookTests()
