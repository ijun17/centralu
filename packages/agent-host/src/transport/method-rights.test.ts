/** What the limited credential may call (#1405, docs/security-boundaries.md "Who holds full power") */
import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'
import { METHOD_RIGHTS, limitedRefusal, limitedRight } from './method-rights.js'

describe('the method classification (#1405)', () => {
  it('classifies every RPC method the protocol has, and nothing else', () => {
    // The table's type already demands it; this catches a method added at runtime only, or a stale key
    expect(Object.keys(METHOD_RIGHTS).sort()).toEqual(Object.keys(RpcMethods).sort())
  })

  it('keeps every permanent deletion, trust change and install behind the person', () => {
    const asks = [
      'trash.purge',
      'trash.purgeRuns',
      'trash.purgeSubagentSteps',
      'trash.empty',
      'agents.deleteSession',
      'agents.deleteAgentChild',
      'agents.deleteOrchestratorSkill',
      'projects.delete',
      'projects.add',
      'projects.create',
      'projects.setTrusted',
      'projects.setCommands',
      'projects.setWorktreeSetup',
      'projects.setAgentInstructions',
      'apps.remove',
      'apps.enable',
      'apps.importCommit',
      'machines.add',
      'machines.remove',
      'machines.install',
      'machines.update',
      'machines.rollback',
      'machines.uninstall',
      'machines.autostart',
      'machines.acceptVersions',
      'updates.apply',
    ]
    for (const m of asks) expect(limitedRight(m, {}), m).toBe('asks')
  })

  it("keeps the owner's orchestration calls everyday (owner, 2026-10-21)", () => {
    for (const m of ['agents.createSession', 'agents.send', 'sessions.rename', 'sessions.list', 'agents.listExternalSessions', 'agents.setSleepPolicy', 'trash.list'])
      expect(limitedRight(m, { projectId: 'p1', tool: 'claude' }), m).toBe('everyday')
  })

  it("never lets the limited credential answer the person's cards or speak as a hub or a bridge", () => {
    for (const m of ['agents.respondApproval', 'agents.answerQuestion', 'apps.answerQuestion', 'updates.answerApply', 'updates.reportApply', 'agents.resolveMcpProposal', 'agents.resolveSkillProposal'])
      expect(limitedRight(m, {}), m).toBe('window')
    for (const m of ['host.send', 'host.hubOffer', 'host.setHubAuto', 'host.readSession']) expect(limitedRight(m, {}), m).toBe('link')
    for (const m of ['orchestrator.tool', 'orchestrator.tools', 'apps.sessionCall', 'apps.sessionTools']) expect(limitedRight(m, {}), m).toBe('bridge')
  })

  it("never lets the limited credential read or write the person's mail: every mail.* call is the window's (#1347)", () => {
    const mail = Object.keys(RpcMethods).filter((m) => m.startsWith('mail.'))
    expect(mail.length).toBeGreaterThan(0)
    for (const m of mail) expect(limitedRight(m, {}), m).toBe('window')
  })

  it('asks when the parameters widen, runs when they narrow, and asks for parameters it cannot read', () => {
    const cases: [string, unknown, 'asks' | 'everyday'][] = [
      ['agents.createSession', { permissionPreset: 'auto' }, 'asks'],
      ['agents.createSession', { permissionPreset: 'normal' }, 'everyday'],
      ['agents.createSession', { permissionPreset: 'safe' }, 'everyday'],
      ['agents.createSession', { permissionPreset: 7 }, 'asks'],
      ['agents.createSession', { projectId: 'p1', fromHub: { callerPreset: 'auto' } }, 'asks'],
      ['agents.createSession', { projectId: 'p1', fromHub: { callerPreset: 'safe' } }, 'asks'],
      ['agents.updateSettings', { sessionId: 's1', permissionPreset: 'auto' }, 'asks'],
      ['agents.updateSettings', { sessionId: 's1', permissionPreset: 'normal' }, 'asks'],
      ['agents.updateSettings', { sessionId: 's1', permissionPreset: 'safe' }, 'everyday'],
      ['agents.updateSettings', { sessionId: 's1', model: 'm' }, 'everyday'],
      ['apps.setShared', { shared: true }, 'asks'],
      ['apps.setShared', { shared: false }, 'everyday'],
      ['apps.setShared', {}, 'asks'],
      ['updates.setAuto', { enabled: true }, 'asks'],
      ['updates.setAuto', { enabled: false }, 'everyday'],
      ['updates.setAutoApply', { enabled: true }, 'asks'],
      ['machines.setAsks', { on: true }, 'asks'],
      ['machines.setAsks', { on: false }, 'everyday'],
      ['machines.hubAuto', { machineId: 'm1' }, 'everyday'],
      ['machines.hubAuto', { machineId: 'm1', allowed: true }, 'asks'],
      ['machines.hubAuto', { machineId: 'm1', allowed: false }, 'everyday'],
      ['prefs.set', { patch: { textSize: 14 } }, 'everyday'],
      ['prefs.set', { patch: { agentCeiling: null } }, 'asks'],
      ['prefs.set', { patch: { agentDepth: 3 } }, 'asks'],
      ['prefs.set', { patch: { hubAuto: true } }, 'asks'],
      ['prefs.set', { patch: { hubAuto: false } }, 'everyday'],
      ['prefs.set', { patch: { notifyPolicy: { approval: false } } }, 'asks'],
      ['prefs.set', { patch: { notifyPolicy: { sound: false } } }, 'asks'],
      ['prefs.set', { patch: { notifyPolicy: { done: false } } }, 'everyday'],
      ['prefs.set', null, 'everyday'],
    ]
    for (const [m, p, want] of cases) expect(limitedRight(m, p), `${m} ${JSON.stringify(p)}`).toBe(want)
  })

  it('refuses a name that is not a method, including one from the object prototype', () => {
    for (const m of ['nope', 'constructor', '__proto__', 'toString']) {
      expect(limitedRight(m, {}), m).toBe('unknown')
      expect(limitedRefusal(m, {})?.rights).toBe('unknown')
    }
    expect(limitedRefusal('sessions.list', {})).toBeNull()
  })
})
