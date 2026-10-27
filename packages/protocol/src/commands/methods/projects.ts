import { methodsOf } from './methods-of.js'
import { projectsParams } from './projects.params.js'
import { projectsResults } from './projects.results.js'

export const projectMethods = methodsOf(projectsParams, projectsResults)
