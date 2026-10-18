import { machineConnectTests } from './fixtures/machine-connect.js'

/**
 * When this computer connects to a linked machine (#1134): Settings → Machines' "Connect only when needed", Connect and
 * Disconnect, and the window's need. The scenarios live in fixtures/machine-connect.ts, which
 * machine-connect-webkit.spec.ts runs again in WebKit.
 */
machineConnectTests()
