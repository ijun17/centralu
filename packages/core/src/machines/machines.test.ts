import { describe, expect, it } from 'vitest'
import type { MachineInfo, MachineVersions } from '@cc/protocol'
import { hostStartNote, installNote, isAway, MACHINE_STATUS_LABEL, machineProblem, operationNote, updateStops, versionPrompt } from './machines.js'

const machine = (patch: Partial<MachineInfo> = {}): MachineInfo => ({
  id: 'box',
  name: 'Box',
  sshTarget: 'me@box',
  shell: 'posix',
  wslDistro: null,
  command: null,
  status: 'connected',
  error: null,
  versions: null,
  lastConnectedAt: null,
  localPort: null,
  sameLocalPort: false,
  hostStarted: null,
  install: null,
  operation: null,
  ...patch,
})

const versions = (patch: Partial<MachineVersions>): MachineVersions => ({
  hub: { version: '0.1.0-beta.12', protocolVersion: 1, dev: false },
  remote: { version: '0.1.0-beta.11', protocolVersion: 1, dev: false },
  older: 'remote',
  compatible: true,
  sameChannel: true,
  accepted: false,
  ...patch,
})

describe('away rows (#82)', () => {
  it('a row of this computer is never away', () => {
    expect(isAway({ machine: null, unreachable: true }, {})).toBe(false)
  })

  it('a row the hub listed from its mirror is away, whatever the machine row says', () => {
    expect(isAway({ machine: 'box', unreachable: true }, { box: machine() })).toBe(true)
  })

  it('a row of a machine whose link is not up is away', () => {
    expect(isAway({ machine: 'box' }, { box: machine({ status: 'unreachable' }) })).toBe(true)
    expect(isAway({ machine: 'box' }, { box: machine({ status: 'versions_differ' }) })).toBe(true)
    expect(isAway({ machine: 'box' }, { box: machine() })).toBe(false)
  })

  it('before the machine list arrives, the row is judged by its own mark', () => {
    expect(isAway({ machine: 'box' }, {})).toBe(false)
  })
})

describe('a link error in plain words (#82)', () => {
  const problem = (status: MachineInfo['status'], error: string | null) => machineProblem(machine({ status, error }))

  it('a key ssh did not offer: run ssh-add', () => {
    const p = problem('unreachable', 'ssh could not reach me@box: me@box: Permission denied (publickey).')
    expect(p?.fix).toMatch(/ssh-add/)
  })

  it('a host key never seen: ssh once in a terminal', () => {
    const p = problem('unreachable', 'ssh could not reach me@box: Host key verification failed.')
    expect(p?.title).toMatch(/host key/)
    expect(p?.fix).toContain('`ssh me@box`')
  })

  it('no centralu on the remote: install it there', () => {
    const p = problem('unreachable', 'Centralu is not installed on me@box (run `npm i -g centralu` there, then `centralu serve` once)')
    expect(p?.title).toBe('Centralu is not installed on Box')
    expect(p?.fix).toContain('npm i -g centralu')
  })

  it('installed but not serving', () => {
    expect(problem('not_running', 'Centralu is installed on Box, but no `centralu serve` is running there')?.fix).toContain('centralu serve')
  })

  it('a machine that does not answer', () => {
    expect(problem('unreachable', 'ssh could not reach me@box: connect to host box port 22: Operation timed out')?.title).toBe('Box does not answer')
  })

  it('anything else is shown as the host said it', () => {
    expect(problem('unreachable', 'something new')).toEqual({ title: 'something new', fix: null })
  })

  it('a connected link has no problem', () => {
    expect(problem('connected', null)).toBeNull()
  })
})

describe('the version prompt (#82, plan §4)', () => {
  it('an older remote: the exact command to run there, and connect anyway', () => {
    const p = versionPrompt(machine({ status: 'versions_differ', versions: versions({}) }))
    expect(p).toMatchObject({ compatible: true, older: 'remote', target: '0.1.0-beta.12', remoteCommand: 'npm i -g centralu@0.1.0-beta.12' })
  })

  it('an older remote is updated from here, unless this computer runs a development build or the machine a command of its own', () => {
    const p = versionPrompt(machine({ status: 'versions_differ', versions: versions({}) }))!
    expect(p.updateHere).toBe(true)
    expect(p.text).toMatch(/Update it, or connect anyway\.$/)
    const dev = versions({})
    expect(versionPrompt(machine({ status: 'versions_differ', versions: { ...dev, hub: { ...dev.hub, dev: true } } }))!.updateHere).toBe(false)
    const own = versionPrompt(machine({ status: 'versions_differ', versions: versions({}), command: '~/bin/centralu' }))!
    expect(own.updateHere).toBe(false)
    expect(own.text).toMatch(/Update it there, or connect anyway\.$/)
  })

  it('an older hub: update this computer, no remote command', () => {
    const p = versionPrompt(
      machine({
        status: 'versions_differ',
        versions: versions({ hub: { version: '0.1.0-beta.10', protocolVersion: 1, dev: false }, older: 'hub' }),
      }),
    )
    expect(p).toMatchObject({ older: 'hub', target: '0.1.0-beta.11', remoteCommand: null })
    expect(p?.text).toMatch(/Update this computer/)
  })

  it('across protocols: not compatible, and says which side to update', () => {
    const p = versionPrompt(
      machine({
        status: 'versions_differ',
        versions: versions({ remote: { version: '0.2.0-beta.1', protocolVersion: 2, dev: false }, older: 'hub', compatible: false }),
      }),
    )
    expect(p?.compatible).toBe(false)
    expect(p?.text).toMatch(/cannot talk to each other until this computer is updated/)
  })

  it('no prompt while the link is not held on versions', () => {
    expect(versionPrompt(machine({ status: 'connected', versions: versions({ accepted: true }) }))).toBeNull()
  })
})

describe('a remote host this computer started (remote-hub.md §10.9, decision 7)', () => {
  it('shows no problem while it is being started, and says why when it could not be', () => {
    expect(machineProblem(machine({ status: 'starting' }))).toBeNull()
    expect(MACHINE_STATUS_LABEL.starting).toBe('starting')
    const p = machineProblem(machine({ status: 'not_running', error: 'Centralu could not be started on Box: centralu serve exited (1)' }))
    expect(p).toEqual({ title: 'Centralu could not be started on Box: centralu serve exited (1)', fix: expect.stringMatching(/centralu serve --detach/) })
  })

  it('says whether it outlives the link, and why not when it does not', () => {
    expect(hostStartNote(machine())).toBeNull()
    expect(hostStartNote(machine({ hostStarted: { how: 'detached', at: 1, note: null } }))).toMatch(/keeps running when this computer disconnects/)
    expect(hostStartNote(machine({ hostStarted: { how: 'link_bound', at: 1, note: 'Windows did not start Centralu through WMI.' } }))).toBe(
      'Centralu runs there only while this computer is linked, and stops with the link. Windows did not start Centralu through WMI.',
    )
  })
})

describe('the update prompt and the install rows (plan §10.5)', () => {
  it('names what stops there, from the remote’s own count, and says unknown as anything running', () => {
    expect(updateStops('Box', { working: 2, approvals: 1, questions: 0, background: 0, terminals: 1, commandRuns: 0 })).toBe(
      'Updating stops Centralu on Box while it switches, and with it 2 working sessions, 1 session waiting on an approval and 1 terminal. Sessions resume on the new version; a turn in progress is lost.',
    )
    expect(updateStops('Box', { working: 0, approvals: 0, questions: 0, background: 0, terminals: 0, commandRuns: 0 })).toBe(
      'Nothing is running on Box. Updating stops Centralu there and starts the new version.',
    )
    expect(updateStops('Box', null)).toMatch(/^Updating stops Centralu on Box while it switches: any agent working there stops/)
  })

  it('says the step while an operation runs, and what this computer installed', () => {
    expect(operationNote(machine({ operation: { kind: 'update', step: 'stop', target: '0.1.0-beta.14', at: 1 } }))).toBe('Updating to 0.1.0-beta.14: stopping Centralu there…')
    expect(operationNote(machine({ operation: { kind: 'update', step: 'roll_back', target: '0.1.0-beta.14', at: 1 } }))).toMatch(/putting the old version back/)
    expect(operationNote(machine({}))).toBeNull()
    expect(installNote(machine({ install: { managed: true, current: { version: '2', node: '24' }, previous: { version: '1', node: '24' } } }))).toBe(
      'Installed from this computer: Centralu 2 (1 kept to roll back to)',
    )
    expect(installNote(machine({ install: { managed: false, current: null, previous: null } }))).toBeNull()
  })
})
