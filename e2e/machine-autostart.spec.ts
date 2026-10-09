import { machineAutostartTests } from './fixtures/machine-autostart.js'

/**
 * Settings → Machines' start-at-boot switch (#82, docs/plans/remote-hub.md §10.4). The scenarios live in
 * fixtures/machine-autostart.ts, which machine-autostart-webkit.spec.ts runs again in WebKit.
 */
machineAutostartTests()
