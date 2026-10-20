import { machineConnectTests } from './fixtures/machine-connect.js'

/**
 * When this computer reconnects to a linked machine (#1341): Settings → Machines' "Auto reconnect", Connect and
 * Disconnect. The scenarios live in fixtures/machine-connect.ts, which
 * machine-connect-webkit.spec.ts runs again in WebKit.
 */
machineConnectTests()
