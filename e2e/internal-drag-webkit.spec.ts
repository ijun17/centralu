import { test } from '@playwright/test'
import { internalDragTests } from './fixtures/internal-drag.js'

/**
 * A drag that started inside the app is never a file from the OS (#286), in WebKit. The desktop app is WKWebView, and
 * WebKit is the engine that put a dragged panel's images on the drag as files — see fixtures/internal-drag.ts.
 */
test.use({ browserName: 'webkit' })

internalDragTests()
