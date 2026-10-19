import { machineAsksTests } from './fixtures/machine-asks.js'

/**
 * Settings → Machines' switch for a machine's sessions to ask this computer's projects, and the card for such an ask
 * (#550, docs/plans/remote-hub.md §12.7). The scenarios live in fixtures/machine-asks.ts, which machine-asks-webkit.spec.ts
 * runs again in WebKit.
 */
machineAsksTests()
