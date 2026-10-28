import { methodsOf } from './methods-of.js'
import { hostParams } from './host.params.js'
import { hostResults } from './host.results.js'

export const hostMethods = methodsOf(hostParams, hostResults)
