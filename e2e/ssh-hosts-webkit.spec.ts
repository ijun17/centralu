import { test } from '@playwright/test'
import { sshHostsTests } from './fixtures/ssh-hosts.js'

/**
 * Settings → Machines → Add a machine from the ssh config (#514), in WebKit: the desktop app is WKWebView (see fixtures/ssh-hosts.ts).
 */
test.use({ browserName: 'webkit' })

sshHostsTests()
