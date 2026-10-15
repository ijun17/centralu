import { test } from '@playwright/test'
import { sidebarMachinesTests } from './fixtures/sidebar-machines.js'

/** The same, in WebKit: the desktop app is WKWebView (#734) */
test.use({ browserName: 'webkit' })

sidebarMachinesTests()
