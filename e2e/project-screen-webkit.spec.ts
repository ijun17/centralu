import { test } from '@playwright/test'
import { appPanelTests, sidebarDropTests } from './fixtures/project-screen.js'

/**
 * The project screen's app panels and sidebar drops, in WebKit (#203). The desktop app is WKWebView: an app's view is
 * laid over its panel by measuring the panel, and a refused drag is the engine's to show — places where the two
 * engines can disagree (see fixtures/project-screen.ts).
 */
test.use({ browserName: 'webkit' })

appPanelTests()
sidebarDropTests()
