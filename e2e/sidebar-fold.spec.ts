import { sidebarFoldTests, orchestratorFoldTests } from './fixtures/sidebar-fold.js'

/**
 * A folded project opens from its whole name row, and the folds of the sidebar are animated (#1605). The scenarios live
 * in the fixture so that the WebKit twin (sidebar-fold-webkit.spec.ts) runs the same ones.
 */
sidebarFoldTests()
orchestratorFoldTests()
