import { describe, expect, it } from 'vitest'
import type { MachineProbe } from '@cc/protocol'
import { firstChoice, probeChoices, probeProblem, sshHostDetail } from './add-machine.js'

const probe = (p: Partial<MachineProbe>): MachineProbe => ({ sshTarget: 'win-pc', reachable: true, os: null, windowsShell: null, wslDistros: [], error: null, ...p })

describe('the Add machine dialog’s rows (#514)', () => {
  it('a Windows PC under cmd.exe with WSL: Windows, then each distro, the default first, ready to add', () => {
    const rows = probeChoices('win-pc', probe({ os: 'windows', windowsShell: 'cmd', wslDistros: [{ name: 'Ubuntu', default: true }, { name: 'Debian', default: false }] }), [])
    expect(rows.map(({ key, label, detail, shell, wslDistro, name, linkedAs }) => ({ key, label, detail, shell, wslDistro, name, linkedAs }))).toEqual([
      { key: 'windows', label: 'Windows', detail: 'cmd.exe answers ssh', shell: 'powershell', wslDistro: null, name: 'win-pc', linkedAs: null },
      { key: 'wsl:Ubuntu', label: 'WSL (Ubuntu)', detail: 'The default distro', shell: 'wsl', wslDistro: 'Ubuntu', name: 'win-pc Ubuntu', linkedAs: null },
      { key: 'wsl:Debian', label: 'WSL (Debian)', detail: null, shell: 'wsl', wslDistro: 'Debian', name: 'win-pc Debian', linkedAs: null },
    ])
    expect(firstChoice(rows)?.key).toBe('windows')
  })

  it('names the shell that answers ssh on Windows', () => {
    const detail = (windowsShell: MachineProbe['windowsShell']) => probeChoices('pc', probe({ os: 'windows', windowsShell }), [])[0]!.detail
    expect([detail('cmd'), detail('powershell'), detail('pwsh'), detail('other'), detail(null)]).toEqual([
      'cmd.exe answers ssh',
      'PowerShell answers ssh',
      'PowerShell 7 answers ssh',
      'Its own default shell answers ssh',
      null,
    ])
  })

  it('a POSIX machine is one row; nothing told is no row', () => {
    expect(probeChoices('box', probe({ os: 'posix' }), []).map((r) => [r.label, r.shell, r.name])).toEqual([['Linux or macOS', 'posix', 'box']])
    expect(probeChoices('box', probe({ os: null }), [])).toEqual([])
    expect(probeChoices('box', probe({ reachable: false }), [])).toEqual([])
  })

  it('marks what is already linked through the alias, and picks the first row that is not', () => {
    const rows = probeChoices('win-pc', probe({ os: 'windows', wslDistros: [{ name: 'Ubuntu', default: true }] }), [
      { machineId: 'win-pc', name: 'Laptop', shell: 'powershell', wslDistro: null },
      { machineId: 'other', name: 'Old WSL', shell: 'wsl', wslDistro: 'Debian' },
    ])
    expect(rows.map((r) => r.linkedAs)).toEqual(['Laptop', null])
    expect(firstChoice(rows)?.key).toBe('wsl:Ubuntu')
    const all = probeChoices('win-pc', probe({ os: 'windows', wslDistros: [{ name: 'Ubuntu', default: true }] }), [
      { machineId: 'a', name: 'A', shell: 'powershell', wslDistro: null },
      { machineId: 'b', name: 'B', shell: 'wsl', wslDistro: 'ubuntu' },
    ])
    expect(firstChoice(all)).toBeNull()
  })

  it('shows what ssh -G resolved as user@host, with a port other than 22', () => {
    expect(sshHostDetail({ alias: 'win-pc', hostName: 'win-pc.example.ts.net', user: 'user', port: 2222 })).toBe('user@win-pc.example.ts.net:2222')
    expect(sshHostDetail({ alias: 'box', hostName: 'box.lan', user: null, port: 22 })).toBe('box.lan')
    expect(sshHostDetail({ alias: 'box', hostName: null, user: null, port: null })).toBeNull()
  })
})

describe('what a probe that told nothing says', () => {
  it('not reached: the link’s own words for ssh’s failure, with a step that fits a dialog', () => {
    expect(probeProblem(probe({ reachable: false, error: 'win-pc: Permission denied (publickey).' }))).toEqual({
      title: 'win-pc did not accept your ssh key',
      fix: 'Your key is probably not loaded: run `ssh-add` in a terminal (or add the key to ~/.ssh/config), then pick it again',
    })
    expect(probeProblem(probe({ reachable: false, error: 'ssh: connect to host x port 22: Operation timed out' }))).toEqual({
      title: 'win-pc does not answer',
      fix: 'It may be asleep, off or on another network',
    })
    expect(probeProblem(probe({ reachable: false, error: 'Host key verification failed.' }))?.fix).toBe('Run `ssh win-pc` once in a terminal and answer yes, then pick it again')
  })

  it('reached but not recognised: says so, and leaves the choice to the person', () => {
    expect(probeProblem(probe({ os: null, error: 'This account is restricted' }))).toEqual({
      title: 'Could not tell what runs on win-pc: This account is restricted',
      fix: 'Enter it by hand, and choose what it runs',
    })
    expect(probeProblem(probe({ os: 'posix' }))).toBeNull()
  })
})
