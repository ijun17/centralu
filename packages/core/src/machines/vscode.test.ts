import { describe, expect, it } from 'vitest'
import { remoteIdeSupport, remoteIdeUrl } from './vscode.js'

const posix = { name: 'Box', sshTarget: 'me@box', shell: 'posix' as const }
const windows = { name: 'Laptop', sshTarget: 'laptop', shell: 'powershell' as const }
const wsl = { name: 'Laptop WSL', sshTarget: 'laptop', shell: 'wsl' as const }

describe('remoteIdeUrl (#82, Remote-SSH links)', () => {
  it('opens a posix project folder over Remote-SSH at its absolute path', () => {
    expect(remoteIdeUrl(posix, '/home/me/proj', '')).toEqual({ ok: true, url: 'vscode://vscode-remote/ssh-remote+me@box/home/me/proj' })
  })

  it('opens a file at its line, and at line 1 when none is known, so VS Code opens it as a file and not a folder', () => {
    expect(remoteIdeUrl(posix, '/home/me/proj', 'src/a.ts', { line: 42 })).toEqual({
      ok: true,
      url: 'vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/a.ts:42',
    })
    expect(remoteIdeUrl(posix, '/home/me/proj/', 'src/a.ts', {})).toEqual({
      ok: true,
      url: 'vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/a.ts:1',
    })
  })

  it('opens a folder inside the project without a line', () => {
    expect(remoteIdeUrl(posix, '/home/me/proj', 'src/app')).toEqual({ ok: true, url: 'vscode://vscode-remote/ssh-remote+me@box/home/me/proj/src/app' })
  })

  it('percent-encodes what would end or change the link: spaces, #, ?, % and non-ASCII names', () => {
    const r = remoteIdeUrl(posix, '/home/me/my proj', 'a#b?c%d/한글.ts', { line: 3 })
    expect(r).toEqual({
      ok: true,
      url: 'vscode://vscode-remote/ssh-remote+me@box/home/me/my%20proj/a%23b%3Fc%25d/%ED%95%9C%EA%B8%80.ts:3',
    })
    // What VS Code reads back after decoding is the path that was meant
    if (r.ok) expect(decodeURIComponent(new URL(r.url).pathname)).toBe('/ssh-remote+me@box/home/me/my proj/a#b?c%d/한글.ts:3')
  })

  it('names a Windows drive path the way VS Code does, /C:/..., from either slash', () => {
    expect(remoteIdeUrl(windows, 'C:\\Users\\me\\proj', 'src/a.ts', { line: 7 })).toEqual({
      ok: true,
      url: 'vscode://vscode-remote/ssh-remote+laptop/C:/Users/me/proj/src/a.ts:7',
    })
    expect(remoteIdeUrl(windows, 'd:/work/proj', '')).toEqual({ ok: true, url: 'vscode://vscode-remote/ssh-remote+laptop/D:/work/proj' })
  })

  it('refuses a Windows root that is not on a drive, and a posix root that is not absolute', () => {
    expect(remoteIdeUrl(windows, '\\\\server\\share\\proj', '').ok).toBe(false)
    expect(remoteIdeUrl(posix, 'proj', '').ok).toBe(false)
  })

  it('refuses a path that climbs out of the project', () => {
    expect(remoteIdeUrl(posix, '/home/me/proj', '../other/a.ts', { line: 1 }).ok).toBe(false)
  })

  it('offers nothing for a WSL machine, and says why: Remote-SSH reaches the Windows side, not the distro', () => {
    const r = remoteIdeUrl(wsl, '/home/me/proj', 'a.ts', { line: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/WSL/)
    expect(remoteIdeSupport(wsl).ok).toBe(false)
  })

  it('offers nothing for a target a link cannot carry, such as an ssh:// URL', () => {
    expect(remoteIdeSupport({ ...posix, sshTarget: 'ssh://me@box:2222' }).ok).toBe(false)
    expect(remoteIdeSupport({ ...posix, sshTarget: '-oProxyCommand=x' }).ok).toBe(false)
    expect(remoteIdeSupport(posix).ok).toBe(true)
  })
})
