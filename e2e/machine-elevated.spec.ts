import { machineElevatedTests } from './fixtures/machine-elevated.js'

/**
 * Settings → Machines' warning for a linked machine whose host runs with administrator rights (#702). The scenario lives
 * in fixtures/machine-elevated.ts, which machine-elevated-webkit.spec.ts runs again in WebKit.
 */
machineElevatedTests()
