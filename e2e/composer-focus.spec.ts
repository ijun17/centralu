import { composerFocusTests } from './fixtures/composer-focus.js'

/**
 * The composer keeps the keyboard (#115). The scenarios live in fixtures/composer-focus.ts, which
 * composer-focus-webkit.spec.ts runs again in WebKit.
 */
composerFocusTests()
