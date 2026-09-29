import { test } from '@playwright/test'
import { appPanelTests } from './fixtures/project-screen.js'

/**
 * The project screen's app panels, in WebKit (#203). The desktop app is WKWebView, and an app's view is laid over
 * its panel by measuring the panel — a place where the two engines can disagree (see fixtures/project-screen.ts).
 */
test.use({ browserName: 'webkit' })

appPanelTests()
