import { methodsOf } from './methods-of.js'
import { terminalParams } from './terminal.params.js'
import { terminalResults } from './terminal.results.js'

export const terminalMethods = methodsOf(terminalParams, terminalResults)
