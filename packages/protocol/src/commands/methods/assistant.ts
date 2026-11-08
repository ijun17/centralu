import { methodsOf } from './methods-of.js'
import { assistantParams } from './assistant.params.js'
import { assistantResults } from './assistant.results.js'

export const assistantMethods = methodsOf(assistantParams, assistantResults)
