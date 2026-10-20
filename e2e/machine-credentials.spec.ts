import { machineCredentialsTests } from './fixtures/machine-credentials.js'

/**
 * Settings → Machines: the other full credentials a linked machine holds, and Revoke (#1405). The scenario lives in
 * fixtures/machine-credentials.ts, which machine-credentials-webkit.spec.ts runs again in WebKit.
 */
machineCredentialsTests()
