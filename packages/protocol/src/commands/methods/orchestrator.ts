import { methodsOf } from './methods-of.js'
import { orchestratorParams } from './orchestrator.params.js'
import { orchestratorResults } from './orchestrator.results.js'

export const orchestratorMethods = methodsOf(orchestratorParams, orchestratorResults)
