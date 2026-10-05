import { test } from '@playwright/test'
import { appAccessTests } from './fixtures/app-access.js'

/** Sharing an app with the person's other projects (#371 part A), in WebKit — the desktop app's engine */
test.use({ browserName: 'webkit' })

appAccessTests()
