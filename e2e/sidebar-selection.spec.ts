import { sidebarSelectionTests } from './fixtures/sidebar-selection.js'

/**
 * The sidebar shows which project is open: its group tinted, the open row in it marked. The scenarios live in
 * fixtures/sidebar-selection.ts, which sidebar-selection-webkit.spec.ts runs again in WebKit.
 */
sidebarSelectionTests()
