import { backForwardTests } from './fixtures/back-forward.js'

/**
 * Back and forward between screens (#374). The scenarios live in fixtures/back-forward.ts, which
 * back-forward-webkit.spec.ts runs again in WebKit.
 */
backForwardTests()
