import { gateParams } from './gate.params.js'
import { gateResults } from './gate.results.js'
import { methodsOf } from './methods-of.js'

export const gateMethods = methodsOf(gateParams, gateResults)
