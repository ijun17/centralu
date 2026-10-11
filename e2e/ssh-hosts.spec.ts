import { sshHostsTests } from './fixtures/ssh-hosts.js'

/**
 * Settings → Machines → Add a machine from the ssh config (#514). The scenarios live in fixtures/ssh-hosts.ts,
 * which ssh-hosts-webkit.spec.ts runs again in WebKit.
 */
sshHostsTests()
