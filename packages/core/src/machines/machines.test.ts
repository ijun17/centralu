import { describe, expect, it } from 'vitest'
import type { MachineInfo, MachineVersions } from '@cc/protocol'
import { asksRow, autostartRow, elevatedNote, hostStartNote, installNote, isAway, MACHINE_STATUS_LABEL, machineProblem, machinesInUse, operationNote, updateStops, versionPrompt } from './machines.js'

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
  connect: 'at_start',
  autostart: null,
  elevated: null,
  asks: null,
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

  it('names the .cmd shims for a PowerShell machine, and the plain names elsewhere (#688)', () => {
    const win = (status: MachineInfo['status'], error: string | null) => machineProblem(machine({ status, error, shell: 'powershell' }))
    expect(win('unreachable', 'Centralu is not installed on Box')?.fix).toBe('Install it there with `npm.cmd i -g centralu`, then run `centralu.cmd serve` once')
    expect(win('not_running', null)?.fix).toMatch(/^Run `centralu\.cmd serve --detach`/)
    expect(win('refused', null)?.fix).toBe('Restart `centralu.cmd serve` there, then reconnect')
    expect(problem('unreachable', 'Centralu is not installed on Box')?.fix).toBe('Install it there with `npm i -g centralu`, then run `centralu serve` once')
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

  it('a connected link on one protocol is offered the update, not held for it (#689)', () => {
    const p = versionPrompt(machine({ status: 'connected', versions: versions({}) }))!
    expect(p).toMatchObject({ held: false, older: 'remote', updateHere: true })
    expect(p.text).toMatch(/Update it, or keep it as it is\.$/)
    expect(versionPrompt(machine({ status: 'versions_differ', versions: versions({}) }))!.held).toBe(true)
  })

  it('a local build brings the remote to the release it was cut from', () => {
    const v = versions({})
    const p = versionPrompt(machine({ status: 'connected', versions: { ...v, hub: { ...v.hub, version: '0.1.0-beta.13.local.2' }, remote: { ...v.remote, version: '0.1.0-beta.12' } } }))!
    expect(p).toMatchObject({ target: '0.1.0-beta.13', remoteCommand: 'npm i -g centralu@0.1.0-beta.13' })
    expect(p.text).toMatch(/a local build; 0\.1\.0-beta\.13 is what gets installed there/)
  })

  it('names the .cmd shims in the command to run on a PowerShell machine (#688)', () => {
    const win = versionPrompt(machine({ status: 'connected', versions: versions({}), shell: 'powershell', command: '~/bin/centralu' }))!
    expect(win).toMatchObject({ remoteCommand: 'npm.cmd i -g centralu@0.1.0-beta.12', centralu: 'centralu.cmd' })
    expect(versionPrompt(machine({ status: 'connected', versions: versions({}) }))).toMatchObject({ remoteCommand: 'npm i -g centralu@0.1.0-beta.12', centralu: 'centralu' })
  })

  it('no prompt while a connected link has nothing to align', () => {
    expect(versionPrompt(machine({ status: 'connected', versions: versions({ older: null }) }))).toBeNull()
    expect(versionPrompt(machine({ status: 'unreachable', versions: versions({}) }))).toBeNull()
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
    // What the hub did on the way (its own Node, #699) follows
    expect(hostStartNote(machine({ hostStarted: { how: 'detached', at: 1, note: 'Centralu installed its own Node 24.21.0 on Box, because the Node there is old.' } }))).toBe(
      'This computer started Centralu there. It keeps running when this computer disconnects. Centralu installed its own Node 24.21.0 on Box, because the Node there is old.',
    )
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
    // A start-at-boot change holds the machine too (#850), and says which way it goes
    expect(operationNote(machine({ operation: { kind: 'autostart', step: 'on', target: null, at: 1 } }))).toBe('Turning on its start at boot…')
    expect(operationNote(machine({ operation: { kind: 'autostart', step: 'off', target: null, at: 1 } }))).toBe('Turning off its start at boot…')
    expect(installNote(machine({ install: { managed: true, current: { version: '2', node: '24' }, previous: { version: '1', node: '24' } } }))).toBe(
      'Installed from this computer: Centralu 2 (1 kept to roll back to)',
    )
    expect(installNote(machine({ install: { managed: false, current: null, previous: null } }))).toBeNull()
  })

  it('names a dev build made there from a commit as one, never as a release (#1036)', () => {
    const dev = { version: '0.3.0-beta.7.local.2', node: '24', source: { kind: 'dev' as const, commit: '0123456789abcdef0123456789abcdef01234567', dirty: false } }
    expect(installNote(machine({ install: { managed: true, current: dev, previous: { version: '0.3.0-beta.7', node: '24' } } }))).toBe(
      'Installed from this computer: Centralu 0.3.0-beta.7.local.2, a dev build of 0123456789 (0.3.0-beta.7 kept to roll back to)',
    )
    expect(installNote(machine({ install: { managed: true, current: { ...dev, source: { ...dev.source, dirty: true } }, previous: null } }))).toBe(
      'Installed from this computer: Centralu 0.3.0-beta.7.local.2, a dev build of 0123456789 with uncommitted changes',
    )
  })
})

describe('the start-at-boot switch (plan §10.4, owner decision 4)', () => {
  it('is offered only where the machine said what it would start it with', () => {
    expect(autostartRow(machine({ autostart: null }))).toBeNull()
    expect(autostartRow(machine({ autostart: { on: false, how: null, linger: null } }))).toBeNull()
    expect(autostartRow(machine({ autostart: { on: false, how: 'systemd', linger: null } }))).toEqual({ label: 'Start Centralu when Box starts', on: false, note: null })
  })

  it('says where it falls short of boot: a user manager that only starts at login, and a Windows sign-in', () => {
    expect(autostartRow(machine({ autostart: { on: true, how: 'systemd', linger: true } }))!.note).toBeNull()
    expect(autostartRow(machine({ autostart: { on: true, how: 'systemd', linger: false } }))!.note).toBe(
      'Until an administrator there runs `sudo loginctl enable-linger $USER` for your account, it starts when you log in to Box, not at boot.',
    )
    expect(autostartRow(machine({ shell: 'powershell', autostart: { on: false, how: 'task', linger: null } }))).toEqual({ label: 'Start Centralu when you sign in to Box', on: false, note: null })
    expect(autostartRow(machine({ shell: 'wsl', autostart: { on: true, how: 'task', linger: null } }))!.note).toBe('Windows starts it at sign-in; with automatic sign-in, that is at boot.')
  })

  it('names the uninstall step that removes it', () => {
    expect(operationNote(machine({ operation: { kind: 'uninstall', step: 'autostart', target: null, at: 1 } }))).toBe('Removing Centralu: removing its start at boot…')
  })
})

describe('a machine whose host runs with administrator rights (#702)', () => {
  it('says so in one sentence with the way out, for Windows and elsewhere, and nothing when the host did not say', () => {
    expect(elevatedNote(machine({ name: 'Win', shell: 'powershell', elevated: true }))).toEqual({
      title: 'Agents on Win run with administrator rights: Windows gives an administrator who signs in over ssh a full, elevated token.',
      fix: 'To run them as an ordinary user, link Win through a standard account with its own ssh key.',
    })
    expect(elevatedNote(machine({ elevated: true }))?.title).toBe('Agents on Box run with administrator rights: its host runs as root.')
    expect(elevatedNote(machine({ elevated: false }))).toBeNull()
    expect(elevatedNote(machine({ elevated: null }))).toBeNull()
  })
})

describe('the switch for a machine’s sessions to ask this computer’s projects (#550)', () => {
  it('says what it allows, is off for a new machine, and says why it cannot work only while it is on', () => {
    expect(asksRow(machine({ asks: null }))).toBeNull()
    const off = asksRow(machine({ asks: { on: false, note: 'old' } }))!
    expect(off).toMatchObject({ label: "Let sessions on Box ask this computer's projects", on: false, note: null })
    expect(off.confirm).toContain('a card asks you on this computer')
    expect(off.confirm).toContain('until you withdraw it')
    expect(asksRow(machine({ asks: { on: true, note: 'Box runs a Centralu from before this' } }))).toMatchObject({ on: true, note: 'Box runs a Centralu from before this' })
  })
})

describe('a machine that connects when needed (#1134)', () => {
  const machines = { lap: machine({ id: 'lap', connect: 'when_needed' }), srv: machine({ id: 'srv' }) }

  it('is needed while its focused session or open project is on screen; a machine connected at start never is', () => {
    expect(machinesInUse({ session: { machine: 'lap' } }, machines)).toEqual(['lap'])
    expect(machinesInUse({ projects: [null, { machine: 'lap' }, { machine: 'lap' }] }, machines)).toEqual(['lap'])
    expect(machinesInUse({ session: { machine: 'srv' }, projects: [{ machine: null }, undefined] }, machines)).toEqual([])
    // A machine the window has no row for yet is not asked about
    expect(machinesInUse({ session: { machine: 'gone' } }, machines)).toEqual([])
  })

  it('is disconnected without a problem to fix, and the row says so', () => {
    expect(machineProblem(machine({ status: 'disconnected' }))).toBeNull()
    expect(MACHINE_STATUS_LABEL.disconnected).toBe('disconnected')
  })
})
