import { methodsOf } from './methods-of.js'
import { sessionsParams } from './sessions.params.js'
import { sessionsResults } from './sessions.results.js'

export const sessionMethods = methodsOf(sessionsParams, sessionsResults)
