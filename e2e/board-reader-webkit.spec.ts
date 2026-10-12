import { test } from '@playwright/test'
import { boardReaderTests } from './fixtures/board-reader.js'

/**
 * The project board's reader in WebKit, the engine the desktop app runs in: its modal dialog, its
 * Esc and where the keyboard goes back to are where the two engines could disagree.
 */
test.use({ browserName: 'webkit' })

boardReaderTests()
