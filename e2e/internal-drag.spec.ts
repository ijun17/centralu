import { internalDragTests } from './fixtures/internal-drag.js'

/** A drag that started inside the app is never a file from the OS (#286) — see fixtures/internal-drag.ts */
internalDragTests()
