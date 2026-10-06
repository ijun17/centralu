import { test } from '@playwright/test'
import { gridLayerTests } from './fixtures/grid-layers.js'

// What a grid panel asks the compositor for (#364), in WebKit, the desktop app's engine, where the layers cost
test.use({ browserName: 'webkit' })

gridLayerTests()
