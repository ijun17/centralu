import { methodsOf } from './methods-of.js'
import { appsParams } from './apps.params.js'
import { appsResults } from './apps.results.js'

export const appMethods = methodsOf(appsParams, appsResults)
