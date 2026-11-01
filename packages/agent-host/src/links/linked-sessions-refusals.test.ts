import { describe, expect, it } from 'vitest'
import type { LinkedProject, LinkedSessions } from '../adapters/contract.js'
import { linkedSessions } from './linked-sessions.js'
import { Qualifier } from './qualifier.js'
import type { RoutedMachine } from './router.js'

/**
 * What every method that acts on a linked machine says for an id no linked machine owns, word for word: the model reads
 * these sentences, so a change to one is a change to what an agent is told. Nothing is sent anywhere.
 */

const sent: string[] = []
const m1: RoutedMachine = {
  id: 'm1',
  name: 'Box',
  q: new Qualifier('m1', 1),
  reachable: true,
  call: async (method) => {
    sent.push(method)
    return []
  },
  lastKnown: () => null,
  observe: () => {},
  hides: () => false,
}

const project: LinkedProject = { id: 'm2.p1', name: 'apps', path: '/srv/apps', defaultTool: 'claude', machine: 'Other', machineId: 'm2' }
const spec = { name: 'x' }

type Call = (r: LinkedSessions) => Promise<unknown>
const NOT_SESSION = 'Not a session of a linked machine: m2.s1'
const NOT_PROJECT = 'Not a project of a linked machine: m2.p1'
const NO_MACHINE = 'No linked machine m2'

const CASES: [string, Call, string][] = [
  ['send', (r) => r.send('m2.s1', 'hi', 'orchestrator'), NOT_SESSION],
  ['updateSettings', (r) => r.updateSettings('m2.s1', { model: 'opus' }), NOT_SESSION],
  ['interrupt', (r) => r.interrupt('m2.s1'), NOT_SESSION],
  ['deleteSession', (r) => r.deleteSession('m2.s1'), NOT_SESSION],
  ['deleteAgentChild', (r) => r.deleteAgentChild!('m2.s1', 'feat/x'), NOT_SESSION],
  ['lastUserMessage', (r) => r.lastUserMessage('m2.s1'), NOT_SESSION],
  ['cards', (r) => r.cards('m2.s1'), NOT_SESSION],
  ['answerQuestion', (r) => r.answerQuestion('m2.s1', 'q1', []), NOT_SESSION],
  ['lastWords', (r) => r.lastWords('m2.s1', 100), NOT_SESSION],
  ['read', (r) => r.read('m2.s1', 10), NOT_SESSION],
  ['projectSessions', (r) => r.projectSessions(project), NOT_PROJECT],
  ['createSession', (r) => r.createSession(project, {}), NOT_PROJECT],
  ['origin', (r) => r.origin(project), NOT_PROJECT],
  ['agentInstructions', (r) => r.agentInstructions!(project), NOT_PROJECT],
  ['hubAuto', (r) => r.hubAuto('m2'), NO_MACHINE],
  ['previewProject', (r) => r.previewProject('m2', spec), NO_MACHINE],
  ['createProject', (r) => r.createProject('m2', spec), NO_MACHINE],
  ['inspectFolder', (r) => r.inspectFolder('m2', '/srv'), NO_MACHINE],
  ['addProject', (r) => r.addProject('m2', '/srv'), NO_MACHINE],
]

describe('an id no linked machine owns', () => {
  it.each(CASES)('%s is refused in the same words, and nothing is sent', async (_name, call, error) => {
    sent.length = 0
    const routed: string[] = []
    const reader = linkedSessions(() => [m1], async (method) => {
      routed.push(method)
      return {}
    })
    expect(await call(reader)).toEqual({ ok: false, error })
    expect(sent).toEqual([])
    expect(routed).toEqual([])
  })
})
